import { spawn, type ChildProcess } from "child_process";
import { NextRequest } from "next/server";
import { MAX_SESSIONS, SESSION_TTL_MS } from "./config";
import {
  deleteSessionFromDisk,
  hasSessionOnDisk,
  isSessionWorthPersisting,
  loadSessionFromDisk,
  purgeExpiredDiskSessionsAndOrphanBlobs,
  renameStoredSessionOnDisk,
  saveSessionMetaAndLogsToDisk,
  saveSessionToDisk,
  wipeEntireDiskStorage,
} from "./disk-store";
import type { BuilderSession } from "@/types/builder";

const globalForSessions = globalThis as unknown as {
  __BUILDER_SESSIONS?: Map<string, BuilderSession>;
  __BUILDER_CLEANUP_TIMER?: NodeJS.Timeout;
  __BUILDER_SAVE_TIMERS?: Map<string, NodeJS.Timeout>;
  __BUILDER_NEEDS_FULL_SAVE?: Set<string>;
};

if (!globalForSessions.__BUILDER_SESSIONS) {
  globalForSessions.__BUILDER_SESSIONS = new Map<string, BuilderSession>();
}
if (!globalForSessions.__BUILDER_SAVE_TIMERS) {
  globalForSessions.__BUILDER_SAVE_TIMERS = new Map<string, NodeJS.Timeout>();
}
if (!globalForSessions.__BUILDER_NEEDS_FULL_SAVE) {
  globalForSessions.__BUILDER_NEEDS_FULL_SAVE = new Set<string>();
}

export const sessions = globalForSessions.__BUILDER_SESSIONS;
const saveTimers = globalForSessions.__BUILDER_SAVE_TIMERS;
const needsFullSave = globalForSessions.__BUILDER_NEEDS_FULL_SAVE;

export function newSession(id: string): BuilderSession {
  const now = Date.now();
  return {
    id,
    title: undefined,
    root: null,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    history: [],
    display: [],
    snapshot: null,
    seen: new Map(),
    readDenied: false,
    events: [],
    pendingChanges: {},
    pendingCommands: {},
    undoStack: [],
    checkpoints: [],
    proc: null,
    procs: new Set(),
    activeCmds: 0,
    logs: "",
    previewUrl: null,
    busy: false,
    abort: null,
    usage: { prompt: 0, output: 0, cached: 0, last: null },
    lastSeen: now,
    closeAt: null,
  };
}

export function renameSession(sid: string, newTitle: string): boolean {
  const cleaned = newTitle.trim().slice(0, 80);
  const s = sessions.get(sid);
  if (s) {
    s.title = cleaned || undefined;
    saveSessionMetaAndLogsToDisk(s);
    return true;
  }
  return renameStoredSessionOnDisk(sid, cleaned);
}

export function persistSessionDebounced(sid?: string, full = true): void {
  if (sid) {
    if (full) needsFullSave.add(sid);
    const existing = saveTimers.get(sid);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      saveTimers.delete(sid);
      const isFull = needsFullSave.has(sid);
      needsFullSave.delete(sid);
      const s = sessions.get(sid);
      if (s) {
        if (isFull) saveSessionToDisk(s);
        else saveSessionMetaAndLogsToDisk(s);
      }
    }, 300);
    t.unref?.();
    saveTimers.set(sid, t);
    return;
  }

  for (const [id, s] of sessions) {
    if (full) needsFullSave.add(id);
    const existing = saveTimers.get(id);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      saveTimers.delete(id);
      const isFull = needsFullSave.has(id);
      needsFullSave.delete(id);
      if (isFull) saveSessionToDisk(s);
      else saveSessionMetaAndLogsToDisk(s);
    }, 300);
    t.unref?.();
    saveTimers.set(id, t);
  }
}

export const persistSessionsDebounced = persistSessionDebounced;

export function flushAllActiveSessionsToDisk(): void {
  for (const [id, s] of sessions) {
    const timer = saveTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      saveTimers.delete(id);
    }
    needsFullSave.delete(id);
    if (isSessionWorthPersisting(s) || hasSessionOnDisk(id)) {
      saveSessionToDisk(s);
    }
  }
}

export function killTree(child: ChildProcess | null): void {
  if (!child || child.killed || !child.pid) return;
  const pid = child.pid;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
    } else {
      process.kill(-pid, "SIGTERM");
      const killTimer = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // already exited
        }
      }, 1500);
      killTimer.unref?.();
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
}

export function killAllProcs(s: BuilderSession): void {
  if (s.proc) {
    killTree(s.proc);
    s.proc = null;
  }
  if (s.procs) {
    for (const p of s.procs) {
      killTree(p);
    }
    s.procs.clear();
  }
  s.activeCmds = 0;
}

export function registerProc(
  s: BuilderSession,
  child: ChildProcess,
  isLongRunning: boolean
): void {
  if (!s.procs) s.procs = new Set();
  s.procs.add(child);
  if (isLongRunning || !s.proc) {
    s.proc = child;
  }
}

export function unregisterProc(s: BuilderSession, child: ChildProcess): void {
  if (s.procs) {
    s.procs.delete(child);
  }
  if (s.proc === child) {
    const remaining = s.procs ? Array.from(s.procs) : [];
    s.proc = remaining.length > 0 ? remaining[remaining.length - 1] : null;
  }
  s.activeCmds = Math.max(0, (s.procs ? s.procs.size : (s.activeCmds || 1) - 1));
}

export function destroySession(id: string): void {
  const s = sessions.get(id);
  if (s) {
    s.abort?.abort();
    killAllProcs(s);
    sessions.delete(id);
  }
  const timer = saveTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    saveTimers.delete(id);
  }
  needsFullSave.delete(id);
  deleteSessionFromDisk(id);
}

export function clearAllSessionsAndStorage(): {
  clearedSessions: number;
  removedBlobs: number;
  freedBytes: number;
} {
  for (const [id, s] of sessions) {
    s.abort?.abort();
    killAllProcs(s);
    const timer = saveTimers.get(id);
    if (timer) clearTimeout(timer);
  }
  sessions.clear();
  saveTimers.clear();
  needsFullSave.clear();
  return wipeEntireDiskStorage();
}

export function purgeExpiredSessions(forceOrphanSweep = false): {
  purgedSessions: number;
  removedBlobs: number;
  freedBytes: number;
} {
  if (forceOrphanSweep) {
    flushAllActiveSessionsToDisk();
  }
  const now = Date.now();
  let ramPurged = 0;
  for (const [id, s] of sessions) {
    const lastActive = s.lastSeen || s.createdAt || now;
    const expiresAt = s.expiresAt || lastActive + SESSION_TTL_MS;
    const expiredByTTL =
      now >= expiresAt && now - lastActive >= SESSION_TTL_MS;
    if (expiredByTTL) {
      destroySession(id);
      ramPurged++;
    }
  }
  const { purgedIds, removedBlobs, freedBytes } =
    purgeExpiredDiskSessionsAndOrphanBlobs(forceOrphanSweep);
  for (const pid of purgedIds) {
    const s = sessions.get(pid);
    if (s) {
      s.abort?.abort();
      killAllProcs(s);
      sessions.delete(pid);
    }
  }
  return {
    purgedSessions: ramPurged + purgedIds.length,
    removedBlobs,
    freedBytes,
  };
}

if (!globalForSessions.__BUILDER_CLEANUP_TIMER) {
  globalForSessions.__BUILDER_CLEANUP_TIMER = setInterval(() => {
    purgeExpiredSessions(false);
  }, 60_000);
  globalForSessions.__BUILDER_CLEANUP_TIMER.unref?.();
}

export function getOrCreateSession(
  req: NextRequest,
  bodySid?: string,
  readOnly = false
): { session?: BuilderSession; error?: string; status?: number } {
  const sid = String(req.headers.get("x-session-id") || bodySid || "");
  if (!/^[0-9a-f-]{36}$/i.test(sid)) {
    return { error: "Bad session id.", status: 400 };
  }

  let s = sessions.get(sid);
  if (!s) {
    const diskSession = loadSessionFromDisk(sid);
    if (diskSession) {
      s = diskSession;
      sessions.set(sid, s);
    } else {
      if (sessions.size >= MAX_SESSIONS) {
        const oldest = [...sessions.values()].sort(
          (a, b) => a.lastSeen - b.lastSeen
        )[0];
        if (oldest) {
          oldest.abort?.abort();
          killAllProcs(oldest);
          if (isSessionWorthPersisting(oldest) || hasSessionOnDisk(oldest.id)) {
            saveSessionToDisk(oldest);
          }
          sessions.delete(oldest.id);
        }
      }
      s = newSession(sid);
      sessions.set(sid, s);
      // CRITICAL GUARD: Never overwrite an existing session directory on disk if loadSessionFromDisk
      // failed transiently, and never write empty ghost sessions to disk on readOnly polls!
      if (!readOnly && !hasSessionOnDisk(sid) && isSessionWorthPersisting(s)) {
        saveSessionToDisk(s);
      }
    }
  }

  const now = Date.now();
  if (!s.createdAt) s.createdAt = now;
  const lastActive = s.lastSeen || s.createdAt;
  if (!s.expiresAt) s.expiresAt = lastActive + SESSION_TTL_MS;

  if (now >= s.expiresAt && now - lastActive >= SESSION_TTL_MS) {
    destroySession(sid);
    s = newSession(sid);
    sessions.set(sid, s);
  }

  if (typeof s.activeCmds !== "number") s.activeCmds = 0;
  if (!s.procs) s.procs = new Set();
  if (!Array.isArray(s.checkpoints)) s.checkpoints = [];

  // Sliding 24h TTL window: extend expiration whenever the session is used
  s.lastSeen = now;
  s.expiresAt = now + SESSION_TTL_MS;
  s.closeAt = null;

  if (!readOnly && (isSessionWorthPersisting(s) || hasSessionOnDisk(sid))) {
    persistSessionDebounced(sid, false);
  }
  return { session: s };
}