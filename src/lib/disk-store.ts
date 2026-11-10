import fs from "fs";
import path from "path";
import crypto from "crypto";
import { SESSION_TTL_MS } from "./config";
import { cleanForDisplay } from "./proposals";
import type {
  BuilderSession,
  CommandProposal,
  DisplayMessage,
  FileProposal,
  HistoryTurn,
  SnapshotData,
  StorageStats,
  StoredSessionSummary,
  UndoItem,
  WorkspaceCheckpoint,
} from "@/types/builder";

export const STORAGE_ROOT = path.resolve(process.cwd(), ".zt-storage");
export const BLOBS_DIR = path.join(STORAGE_ROOT, "blobs");
export const SESSIONS_DIR = path.join(STORAGE_ROOT, "sessions");

const LEGACY_STORE_DIR = path.resolve(process.cwd(), ".zt-session-store");

function ensureDirs(): void {
  fs.mkdirSync(BLOBS_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  try {
    if (fs.existsSync(LEGACY_STORE_DIR)) {
      fs.rmSync(LEGACY_STORE_DIR, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
}

export function sha1Hash(content: string | Buffer): string {
  return crypto.createHash("sha1").update(content).digest("hex");
}

function atomicWriteFile(filePath: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 7)}.tmp`;
  fs.writeFileSync(tmpPath, data);
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    try {
      fs.writeFileSync(filePath, data);
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    }
  }
}

function readJsonFileSafe<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      if (!raw.trim()) continue;
      return JSON.parse(raw) as T;
    } catch {
      // small spin wait for Windows concurrent rename/write
    }
  }
  return null;
}

export function normalizeRootPath(p: string | null | undefined): string {
  if (!p) return "";
  const resolved = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isSessionWorthPersisting(s: BuilderSession): boolean {
  return Boolean(
    s.root ||
      s.display.length > 0 ||
      s.history.length > 0 ||
      Object.keys(s.pendingChanges).length > 0 ||
      Object.keys(s.pendingCommands).length > 0 ||
      s.checkpoints.length > 0 ||
      s.undoStack.length > 0 ||
      (s.title && s.title.trim())
  );
}

export function hasSessionOnDisk(sid: string): boolean {
  if (!/^[0-9a-f-]{36}$/i.test(sid)) return false;
  return fs.existsSync(path.join(sessionDir(sid), "meta.json"));
}

// ============================================================================
// 1. CONTENT-ADDRESSABLE BLOB STORE (.zt-storage/blobs/<sha1>.blob)
// ============================================================================

export function putBlob(content: string | null | undefined): string | null {
  if (content === null || content === undefined) return null;
  ensureDirs();
  const hash = sha1Hash(content);
  const blobPath = path.join(BLOBS_DIR, `${hash}.blob`);
  if (!fs.existsSync(blobPath)) {
    atomicWriteFile(blobPath, content);
  }
  return hash;
}

export function getBlob(hash: string | null | undefined): string | null {
  if (!hash || !/^[0-9a-f]{40}$/i.test(hash)) return null;
  const blobPath = path.join(BLOBS_DIR, `${hash}.blob`);
  try {
    if (fs.existsSync(blobPath)) {
      return fs.readFileSync(blobPath, "utf-8");
    }
  } catch {
    // ignore
  }
  return null;
}

// ============================================================================
// 2. PER-SESSION DIRECTORY STRUCTURE (.zt-storage/sessions/<sid>/)
// ============================================================================

export function sessionDir(sid: string): string {
  return path.join(SESSIONS_DIR, sid);
}

interface DiskSessionMeta {
  id: string;
  root: string | null;
  createdAt: number;
  expiresAt: number;
  lastSeen: number;
  readDenied: boolean;
  seen: Array<[string, string]>;
  events: string[];
  pendingCommands: Record<string, CommandProposal>;
  previewUrl: string | null;
  usage: BuilderSession["usage"];
  title?: string;
}

interface DiskProposalRecord {
  id: string;
  kind: "write" | "delete";
  relPath: string;
  contentHash: string | null;
  oldContentHash: string | null;
  turn: number;
  baseHash: string | null;
  action: FileProposal["action"];
  needsNewFolder?: boolean;
  folderToCreate?: string | null;
  isCritical?: boolean;
  criticalReason?: string | null;
}

interface DiskUndoRecord {
  rel: string;
  prevHash: string | null;
  turn?: number;
  propId?: string;
}

interface DiskCheckpointRecord {
  id: string;
  name: string;
  ts: number;
  fileCount: number;
  blobHashes: Record<string, string>;
}

interface DiskSnapshotRecord {
  textHash: string | null;
  count: number;
  omitted: string[];
}

// ============================================================================
// 3. APPEND-ONLY JSONL HELPERS (display.jsonl & history.jsonl) + SELF-RECOVERY
// ============================================================================

export function appendChatTurnToDisk(
  sid: string,
  userDisplay: DisplayMessage,
  modelDisplay: DisplayMessage,
  userHist: HistoryTurn,
  modelHist: HistoryTurn
): void {
  try {
    const dir = sessionDir(sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "display.jsonl"),
      JSON.stringify(userDisplay) + "\n" + JSON.stringify(modelDisplay) + "\n",
      "utf-8"
    );
    fs.appendFileSync(
      path.join(dir, "history.jsonl"),
      JSON.stringify(userHist) + "\n" + JSON.stringify(modelHist) + "\n",
      "utf-8"
    );
  } catch {
    // ignore
  }
}

export function writeChatLogsToDisk(s: BuilderSession): void {
  try {
    const dir = sessionDir(s.id);
    fs.mkdirSync(dir, { recursive: true });

    const dispPath = path.join(dir, "display.jsonl");
    // Guard against accidentally clobbering existing JSONL on disk with an empty array
    if (s.display.length === 0 && fs.existsSync(dispPath)) {
      const existingDisp = readJsonlFile<DisplayMessage>(dispPath);
      if (existingDisp.length > 0) {
        s.display = existingDisp;
      }
    }
    const dispText = s.display.map((m) => JSON.stringify(m)).join("\n");
    atomicWriteFile(dispPath, dispText ? dispText + "\n" : "");

    const histPath = path.join(dir, "history.jsonl");
    if (s.history.length === 0 && fs.existsSync(histPath)) {
      const existingHist = readJsonlFile<HistoryTurn>(histPath);
      if (existingHist.length > 0) {
        s.history = existingHist;
      }
    }
    const histText = s.history.map((h) => JSON.stringify(h)).join("\n");
    atomicWriteFile(histPath, histText ? histText + "\n" : "");
  } catch {
    // ignore
  }
}

export function clearSessionChatLogsOnDisk(sid: string): void {
  try {
    const dir = sessionDir(sid);
    if (!fs.existsSync(dir)) return;
    atomicWriteFile(path.join(dir, "display.jsonl"), "");
    atomicWriteFile(path.join(dir, "history.jsonl"), "");
  } catch {
    // ignore
  }
}

function readJsonlFile<T>(filePath: string): T[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");
    const out: T[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // skip malformed line
      }
    }
    return out;
  } catch {
    return [];
  }
}

function extractUserPromptFromHistoryText(raw: string): string {
  const m = raw.match(
    /=== USER REQUEST(?:\s*\[MODE:\s*(?:BUILD|TALK)\])?\s*===\n([\s\S]*?)(?:\n\n\(ACTIVE MODE:|$)/
  );
  return (m ? m[1] : raw).trim();
}

function reconcileDisplayAndHistory(
  display: DisplayMessage[],
  history: HistoryTurn[],
  fallbackTs: number
): { display: DisplayMessage[]; history: HistoryTurn[] } {
  // Case 1: history.jsonl has turns, but display.jsonl is missing or shorter -> reconstruct display
  if (history.length > 0 && display.length === 0) {
    const rebuiltDisplay: DisplayMessage[] = [];
    for (let i = 0; i < history.length; i++) {
      const h = history[i];
      const rawText = h.parts?.[0]?.text || "";
      if (h.role === "user") {
        const isTalk = /\[MODE:\s*TALK\]/.test(rawText);
        rebuiltDisplay.push({
          role: "user",
          text: extractUserPromptFromHistoryText(rawText),
          ts: fallbackTs,
          mode: isTalk ? "talk" : "build",
        });
      } else {
        rebuiltDisplay.push({
          role: "model",
          text: cleanForDisplay(rawText, "build"),
          ts: fallbackTs,
          mode: "build",
        });
      }
    }
    return { display: rebuiltDisplay, history };
  }

  // Case 2: display.jsonl has messages, but history.jsonl is missing -> reconstruct history
  if (display.length > 0 && history.length === 0) {
    const rebuiltHistory: HistoryTurn[] = display.map((d) => ({
      role: d.role,
      parts: [{ text: d.text }],
    }));
    return { display, history: rebuiltHistory };
  }

  return { display, history };
}

// ============================================================================
// 4. PROPOSALS, UNDO, SNAPSHOT, CHECKPOINTS & ATTACHMENTS ON DISK
// ============================================================================

export function saveProposalToDisk(sid: string, p: FileProposal): void {
  try {
    const propsDir = path.join(sessionDir(sid), "proposals");
    fs.mkdirSync(propsDir, { recursive: true });
    const contentHash =
      p.contentHash !== undefined ? p.contentHash : putBlob(p.content ?? null);
    const oldContentHash =
      p.oldContentHash !== undefined
        ? p.oldContentHash
        : putBlob(p.oldContent ?? null);
    p.contentHash = contentHash;
    p.oldContentHash = oldContentHash;

    const record: DiskProposalRecord = {
      id: p.id,
      kind: p.kind,
      relPath: p.relPath,
      contentHash,
      oldContentHash,
      turn: p.turn,
      baseHash: p.baseHash,
      action: p.action,
      needsNewFolder: p.needsNewFolder,
      folderToCreate: p.folderToCreate,
      isCritical: p.isCritical,
      criticalReason: p.criticalReason,
    };
    atomicWriteFile(
      path.join(propsDir, `${p.id}.json`),
      JSON.stringify(record)
    );
  } catch {
    // ignore
  }
}

export function deleteProposalFromDisk(sid: string, propId: string): void {
  try {
    const f = path.join(sessionDir(sid), "proposals", `${propId}.json`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch {
    // ignore
  }
}

export function clearSessionProposalsOnDisk(sid: string): void {
  try {
    const propsDir = path.join(sessionDir(sid), "proposals");
    if (fs.existsSync(propsDir)) {
      fs.rmSync(propsDir, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
}

export function clearSessionAttachmentsOnDisk(sid: string): void {
  try {
    const attDir = path.join(sessionDir(sid), "attachments");
    if (fs.existsSync(attDir)) {
      fs.rmSync(attDir, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
}

export function hydrateProposal(p: FileProposal): FileProposal {
  if (p.content === undefined && p.contentHash) {
    const c = getBlob(p.contentHash);
    if (c !== null) p.content = c;
  }
  if (p.oldContent === null && p.oldContentHash) {
    const o = getBlob(p.oldContentHash);
    if (o !== null) p.oldContent = o;
  }
  return p;
}

export function saveSnapshotToDisk(
  sid: string,
  snapshot: SnapshotData | null
): void {
  try {
    const snapFile = path.join(sessionDir(sid), "snapshot.json");
    if (!snapshot) {
      if (fs.existsSync(snapFile)) fs.unlinkSync(snapFile);
      return;
    }
    const textHash = snapshot.textHash || putBlob(snapshot.text);
    snapshot.textHash = textHash || undefined;
    const rec: DiskSnapshotRecord = {
      textHash,
      count: snapshot.count,
      omitted: snapshot.omitted,
    };
    atomicWriteFile(snapFile, JSON.stringify(rec));
  } catch {
    // ignore
  }
}

export function saveUndoStackToDisk(sid: string, undoStack: UndoItem[]): void {
  try {
    const records: DiskUndoRecord[] = undoStack.slice(-300).map((u) => {
      const prevHash =
        u.prevHash !== undefined ? u.prevHash : putBlob(u.prev ?? null);
      u.prevHash = prevHash;
      return {
        rel: u.rel,
        prevHash,
        turn: u.turn,
        propId: u.propId,
      };
    });
    atomicWriteFile(
      path.join(sessionDir(sid), "undo.json"),
      JSON.stringify(records)
    );
  } catch {
    // ignore
  }
}

export function saveCheckpointToDisk(
  sid: string,
  cp: WorkspaceCheckpoint
): void {
  try {
    const cpDir = path.join(sessionDir(sid), "checkpoints");
    fs.mkdirSync(cpDir, { recursive: true });
    const blobHashes: Record<string, string> = cp.blobHashes || {};
    if (cp.files && cp.files.size > 0) {
      for (const [rel, content] of cp.files.entries()) {
        const h = putBlob(content);
        if (h) blobHashes[rel] = h;
      }
      cp.blobHashes = blobHashes;
      cp.files = new Map();
    }
    const rec: DiskCheckpointRecord = {
      id: cp.id,
      name: cp.name,
      ts: cp.ts,
      fileCount: cp.fileCount,
      blobHashes,
    };
    atomicWriteFile(path.join(cpDir, `${cp.id}.json`), JSON.stringify(rec));
  } catch {
    // ignore
  }
}

export function deleteCheckpointFromDisk(sid: string, cpId: string): void {
  try {
    const f = path.join(sessionDir(sid), "checkpoints", `${cpId}.json`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch {
    // ignore
  }
}

export function hydrateCheckpointFiles(
  cp: WorkspaceCheckpoint
): Map<string, string> {
  if (cp.files && cp.files.size > 0) return cp.files;
  const map = new Map<string, string>();
  if (cp.blobHashes) {
    for (const [rel, hash] of Object.entries(cp.blobHashes)) {
      const content = getBlob(hash);
      if (content !== null) {
        map.set(rel, content);
      }
    }
  }
  return map;
}

export function saveAttachmentToDisk(
  sid: string,
  attId: string,
  name: string,
  mime: string,
  base64Data: string
): string {
  try {
    const safeId = attId.replace(/[^a-zA-Z0-9_-]/g, "");
    const attDir = path.join(sessionDir(sid), "attachments");
    fs.mkdirSync(attDir, { recursive: true });
    const buf = Buffer.from(base64Data, "base64");
    atomicWriteFile(path.join(attDir, `${safeId}.bin`), buf);
    atomicWriteFile(
      path.join(attDir, `${safeId}.json`),
      JSON.stringify({ id: safeId, name, mime, size: buf.length })
    );
    return `/api/attachments/${sid}/${safeId}`;
  } catch {
    return "";
  }
}

export function readAttachmentFromDisk(
  sid: string,
  attId: string
): { buf: Buffer; mime: string; name: string } | null {
  try {
    const safeId = attId.replace(/[^a-zA-Z0-9_-]/g, "");
    const attDir = path.join(sessionDir(sid), "attachments");
    const binPath = path.join(attDir, `${safeId}.bin`);
    const metaPath = path.join(attDir, `${safeId}.json`);
    if (!fs.existsSync(binPath) || !fs.existsSync(metaPath)) return null;
    const meta = readJsonFileSafe<{ mime?: string; name?: string }>(metaPath);
    if (!meta) return null;
    const buf = fs.readFileSync(binPath);
    return {
      buf,
      mime: meta.mime || "application/octet-stream",
      name: meta.name || safeId,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// 5. FAST METADATA SYNC vs FULL SESSION PERSISTENCE
// ============================================================================

export function buildDefaultSessionTitle(
  root: string | null,
  firstPrompt?: string,
  customTitle?: string
): string {
  if (customTitle && customTitle.trim() && customTitle !== "Untitled Session") {
    return customTitle.trim().slice(0, 80);
  }
  const folderName = root ? path.basename(root) : "";
  const promptSnippet = firstPrompt ? firstPrompt.trim().slice(0, 50) : "";
  if (folderName && promptSnippet) {
    return `${folderName} — ${promptSnippet}`.slice(0, 80);
  }
  if (promptSnippet) return promptSnippet;
  if (folderName) return `📁 ${folderName}`;
  return "Untitled Session";
}

export function saveSessionMetaAndLogsToDisk(s: BuilderSession): void {
  try {
    if (!isSessionWorthPersisting(s) && !hasSessionOnDisk(s.id)) {
      return;
    }
    ensureDirs();
    const dir = sessionDir(s.id);
    fs.mkdirSync(dir, { recursive: true });

    const firstUserMsg = s.display.find((m) => m.role === "user");
    const title = buildDefaultSessionTitle(
      s.root,
      firstUserMsg?.text,
      s.title
    );

    const meta: DiskSessionMeta = {
      id: s.id,
      root: s.root,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      lastSeen: s.lastSeen,
      readDenied: s.readDenied,
      seen: Array.from(s.seen.entries()),
      events: s.events.slice(-50),
      pendingCommands: s.pendingCommands,
      previewUrl: s.previewUrl,
      usage: s.usage,
      title,
    };
    atomicWriteFile(path.join(dir, "meta.json"), JSON.stringify(meta));
    atomicWriteFile(
      path.join(dir, "terminal.log"),
      (s.logs || "").slice(-60_000)
    );
  } catch {
    // ignore
  }
}

export function renameStoredSessionOnDisk(
  sid: string,
  newTitle: string
): boolean {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(sid)) return false;
    const metaPath = path.join(sessionDir(sid), "meta.json");
    const meta = readJsonFileSafe<DiskSessionMeta>(metaPath);
    if (!meta) return false;
    const cleaned = newTitle.trim().slice(0, 80);
    meta.title =
      cleaned ||
      (meta.root ? `📁 ${path.basename(meta.root)}` : `Session ${sid.slice(0, 8)}`);
    atomicWriteFile(metaPath, JSON.stringify(meta));
    return true;
  } catch {
    return false;
  }
}

export function saveSessionToDisk(s: BuilderSession): void {
  try {
    if (!isSessionWorthPersisting(s) && !hasSessionOnDisk(s.id)) {
      return;
    }
    saveSessionMetaAndLogsToDisk(s);
    const dir = sessionDir(s.id);

    writeChatLogsToDisk(s);
    saveSnapshotToDisk(s.id, s.snapshot);
    saveUndoStackToDisk(s.id, s.undoStack);

    // Sync proposals folder (and remove any stale proposal JSON files)
    const propsDir = path.join(dir, "proposals");
    fs.mkdirSync(propsDir, { recursive: true });
    const activePropIds = new Set(Object.keys(s.pendingChanges));
    for (const p of Object.values(s.pendingChanges)) {
      saveProposalToDisk(s.id, p);
    }
    for (const f of fs.readdirSync(propsDir)) {
      if (f.endsWith(".json")) {
        const pid = f.slice(0, -5);
        if (!activePropIds.has(pid)) {
          try {
            fs.unlinkSync(path.join(propsDir, f));
          } catch {
            // ignore
          }
        }
      }
    }

    // Sync checkpoints folder (and remove any evicted or cleared checkpoint JSON files)
    const cpDir = path.join(dir, "checkpoints");
    fs.mkdirSync(cpDir, { recursive: true });
    const activeCpIds = new Set((s.checkpoints || []).map((c) => c.id));
    for (const cp of s.checkpoints || []) {
      const cpFile = path.join(cpDir, `${cp.id}.json`);
      if (!fs.existsSync(cpFile)) {
        saveCheckpointToDisk(s.id, cp);
      }
    }
    for (const f of fs.readdirSync(cpDir)) {
      if (f.endsWith(".json")) {
        const cid = f.slice(0, -5);
        if (!activeCpIds.has(cid)) {
          try {
            fs.unlinkSync(path.join(cpDir, f));
          } catch {
            // ignore
          }
        }
      }
    }
  } catch {
    // ignore disk errors
  }
}

export function loadSessionFromDisk(sid: string): BuilderSession | null {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(sid)) return null;
    const dir = sessionDir(sid);
    const metaPath = path.join(dir, "meta.json");
    if (!fs.existsSync(metaPath)) return null;

    const meta = readJsonFileSafe<DiskSessionMeta>(metaPath);
    if (!meta) return null;

    const now = Date.now();
    const createdAt = Number(meta.createdAt) || now;
    const lastSeen = Number(meta.lastSeen) || createdAt;
    const expiresAt = Number(meta.expiresAt) || lastSeen + SESSION_TTL_MS;

    // Sliding 24-hour TTL window based on lastSeen / expiresAt
    if (now >= expiresAt && now - lastSeen >= SESSION_TTL_MS) {
      deleteSessionFromDisk(sid);
      return null;
    }

    const rawDisplay = readJsonlFile<DisplayMessage>(
      path.join(dir, "display.jsonl")
    );
    const rawHistory = readJsonlFile<HistoryTurn>(
      path.join(dir, "history.jsonl")
    );
    const { display, history } = reconcileDisplayAndHistory(
      rawDisplay,
      rawHistory,
      lastSeen
    );

    let snapshot: SnapshotData | null = null;
    const snapPath = path.join(dir, "snapshot.json");
    const sr = readJsonFileSafe<DiskSnapshotRecord>(snapPath);
    if (sr) {
      const snapText = getBlob(sr.textHash);
      if (snapText !== null) {
        snapshot = {
          text: snapText,
          textHash: sr.textHash || undefined,
          count: sr.count,
          omitted: sr.omitted || [],
        };
      }
    }

    const pendingChanges: Record<string, FileProposal> = {};
    const propsDir = path.join(dir, "proposals");
    if (fs.existsSync(propsDir)) {
      for (const f of fs.readdirSync(propsDir)) {
        if (!f.endsWith(".json")) continue;
        const rec = readJsonFileSafe<DiskProposalRecord>(
          path.join(propsDir, f)
        );
        if (!rec) continue;
        const prop: FileProposal = {
          id: rec.id,
          kind: rec.kind,
          relPath: rec.relPath,
          content: getBlob(rec.contentHash) ?? undefined,
          contentHash: rec.contentHash,
          oldContent: getBlob(rec.oldContentHash),
          oldContentHash: rec.oldContentHash,
          turn: rec.turn,
          baseHash: rec.baseHash,
          action: rec.action,
          needsNewFolder: rec.needsNewFolder,
          folderToCreate: rec.folderToCreate,
          isCritical: rec.isCritical,
          criticalReason: rec.criticalReason,
        };
        pendingChanges[prop.id] = prop;
      }
    }

    const undoStack: UndoItem[] = [];
    const undoPath = path.join(dir, "undo.json");
    const uList = readJsonFileSafe<DiskUndoRecord[]>(undoPath);
    if (Array.isArray(uList)) {
      for (const u of uList) {
        undoStack.push({
          rel: u.rel,
          prev: null,
          prevHash: u.prevHash,
          turn: u.turn,
          propId: u.propId,
        });
      }
    }

    const checkpoints: WorkspaceCheckpoint[] = [];
    const cpDir = path.join(dir, "checkpoints");
    if (fs.existsSync(cpDir)) {
      for (const f of fs.readdirSync(cpDir)) {
        if (!f.endsWith(".json")) continue;
        const rec = readJsonFileSafe<DiskCheckpointRecord>(path.join(cpDir, f));
        if (!rec) continue;
        checkpoints.push({
          id: rec.id,
          name: rec.name,
          ts: rec.ts,
          fileCount: rec.fileCount,
          files: new Map(),
          blobHashes: rec.blobHashes || {},
        });
      }
      checkpoints.sort((a, b) => b.ts - a.ts);
    }

    let logs = "";
    const termPath = path.join(dir, "terminal.log");
    if (fs.existsSync(termPath)) {
      try {
        logs = fs.readFileSync(termPath, "utf-8");
      } catch {
        logs = "";
      }
    }

    const firstUserMsg = display.find((m) => m.role === "user");
    const resolvedTitle = buildDefaultSessionTitle(
      meta.root || null,
      firstUserMsg?.text,
      meta.title
    );

    return {
      id: meta.id || sid,
      title: resolvedTitle !== "Untitled Session" ? resolvedTitle : undefined,
      root: meta.root || null,
      createdAt,
      expiresAt: Math.max(expiresAt, now + SESSION_TTL_MS),
      history,
      display,
      snapshot,
      seen: new Map(Array.isArray(meta.seen) ? meta.seen : []),
      readDenied: Boolean(meta.readDenied),
      events: Array.isArray(meta.events) ? meta.events : [],
      pendingChanges,
      pendingCommands: meta.pendingCommands || {},
      undoStack,
      checkpoints,
      proc: null,
      procs: new Set(),
      activeCmds: 0,
      logs,
      previewUrl: meta.previewUrl || null,
      busy: false,
      abort: null,
      usage: meta.usage || { prompt: 0, output: 0, cached: 0, last: null },
      lastSeen: now,
      closeAt: null,
    };
  } catch {
    return null;
  }
}

/**
 * Finds the most recent saved session on disk for a specific workspace folder path.
 * Prefers sessions that have chat history/turns or undo/checkpoint state.
 */
export function findLatestSessionByRoot(
  targetRoot: string,
  excludeSid?: string
): BuilderSession | null {
  ensureDirs();
  const targetNorm = normalizeRootPath(targetRoot);
  if (!targetNorm) return null;

  const candidates: Array<{ sid: string; score: number; lastSeen: number }> = [];
  try {
    for (const e of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const sid = e.name;
      if (excludeSid && sid === excludeSid) continue;
      const dir = path.join(SESSIONS_DIR, sid);
      const meta = readJsonFileSafe<DiskSessionMeta>(
        path.join(dir, "meta.json")
      );
      if (!meta || !meta.root) continue;
      if (normalizeRootPath(meta.root) !== targetNorm) continue;

      let msgCount = 0;
      const dispPath = path.join(dir, "display.jsonl");
      if (fs.existsSync(dispPath)) {
        try {
          msgCount = fs
            .readFileSync(dispPath, "utf-8")
            .split("\n")
            .filter((l) => l.trim()).length;
        } catch {
          // ignore
        }
      }
      if (msgCount === 0) {
        const histPath = path.join(dir, "history.jsonl");
        if (fs.existsSync(histPath)) {
          try {
            msgCount = fs
              .readFileSync(histPath, "utf-8")
              .split("\n")
              .filter((l) => l.trim()).length;
          } catch {
            // ignore
          }
        }
      }

      const hasActivity =
        msgCount > 0 ||
        (meta.usage && meta.usage.prompt > 0) ||
        (Array.isArray(meta.events) && meta.events.length > 0);

      candidates.push({
        sid,
        score: (hasActivity ? 1_000_000 : 0) + msgCount * 100,
        lastSeen: Number(meta.lastSeen) || Number(meta.createdAt) || 0,
      });
    }
  } catch {
    return null;
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || b.lastSeen - a.lastSeen);
  return loadSessionFromDisk(candidates[0].sid);
}

export function deleteSessionFromDisk(sid: string): void {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(sid)) return;
    const dir = sessionDir(sid);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
}

// ============================================================================
// 6. 24-HOUR TTL JANITOR + ORPHAN BLOB GC + ONE-CLICK WIPE ALL STORAGE
// ============================================================================

export function wipeEntireDiskStorage(): {
  clearedSessions: number;
  removedBlobs: number;
  freedBytes: number;
} {
  ensureDirs();
  let clearedSessions = 0;
  let removedBlobs = 0;
  let freedBytes = 0;

  try {
    if (fs.existsSync(SESSIONS_DIR)) {
      for (const e of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
        if (e.isDirectory()) {
          clearedSessions++;
          const full = path.join(SESSIONS_DIR, e.name);
          freedBytes += getDirBytes(full);
          fs.rmSync(full, { recursive: true, force: true });
        }
      }
    }
    if (fs.existsSync(BLOBS_DIR)) {
      for (const bf of fs.readdirSync(BLOBS_DIR)) {
        if (bf.endsWith(".blob")) {
          removedBlobs++;
          const fullBlob = path.join(BLOBS_DIR, bf);
          try {
            freedBytes += fs.statSync(fullBlob).size;
            fs.unlinkSync(fullBlob);
          } catch {
            // ignore
          }
        }
      }
    }
  } catch {
    // ignore
  }

  ensureDirs();
  return { clearedSessions, removedBlobs, freedBytes };
}

export function purgeExpiredDiskSessionsAndOrphanBlobs(
  forceOrphanSweep = false
): {
  purgedIds: string[];
  removedBlobs: number;
  freedBytes: number;
} {
  ensureDirs();
  const purgedIds: string[] = [];
  let removedBlobs = 0;
  let freedBytes = 0;
  const referencedBlobs = new Set<string>();
  const now = Date.now();

  try {
    const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sid = entry.name;
      const dir = path.join(SESSIONS_DIR, sid);
      const metaPath = path.join(dir, "meta.json");

      let expired = false;
      try {
        if (!fs.existsSync(metaPath)) {
          const st = fs.statSync(dir);
          if (now - st.mtimeMs >= SESSION_TTL_MS) expired = true;
        } else {
          const meta = readJsonFileSafe<DiskSessionMeta>(metaPath);
          if (meta) {
            const createdAt = Number(meta.createdAt) || 0;
            const lastSeen = Number(meta.lastSeen) || createdAt;
            const expiresAt =
              Number(meta.expiresAt) || lastSeen + SESSION_TTL_MS;
            if (now >= expiresAt && now - lastSeen >= SESSION_TTL_MS) {
              expired = true;
            }
          }
          // NOTE: If meta is null due to a transient concurrent write lock,
          // NEVER mark expired = true! Leave the session intact.
        }
      } catch {
        expired = false;
      }

      if (expired) {
        try {
          freedBytes += getDirBytes(dir);
          fs.rmSync(dir, { recursive: true, force: true });
          purgedIds.push(sid);
        } catch {
          // ignore
        }
        continue;
      }

      // Collect referenced SHA-1 hashes from active sessions on disk
      try {
        const snapPath = path.join(dir, "snapshot.json");
        const sr = readJsonFileSafe<DiskSnapshotRecord>(snapPath);
        if (sr?.textHash) referencedBlobs.add(sr.textHash);

        const undoPath = path.join(dir, "undo.json");
        const uList = readJsonFileSafe<DiskUndoRecord[]>(undoPath);
        if (Array.isArray(uList)) {
          for (const u of uList) {
            if (u.prevHash) referencedBlobs.add(u.prevHash);
          }
        }
        const propsDir = path.join(dir, "proposals");
        if (fs.existsSync(propsDir)) {
          for (const pf of fs.readdirSync(propsDir)) {
            if (!pf.endsWith(".json")) continue;
            const pr = readJsonFileSafe<DiskProposalRecord>(
              path.join(propsDir, pf)
            );
            if (pr?.contentHash) referencedBlobs.add(pr.contentHash);
            if (pr?.oldContentHash) referencedBlobs.add(pr.oldContentHash);
          }
        }
        const cpDir = path.join(dir, "checkpoints");
        if (fs.existsSync(cpDir)) {
          for (const cf of fs.readdirSync(cpDir)) {
            if (!cf.endsWith(".json")) continue;
            const cr = readJsonFileSafe<DiskCheckpointRecord>(
              path.join(cpDir, cf)
            );
            for (const h of Object.values(cr?.blobHashes || {})) {
              if (h) referencedBlobs.add(h);
            }
          }
        }
      } catch {
        // ignore
      }
    }

    // Sweep unreferenced blobs (immediately if manual GC, or >5 mins old for background sweep)
    if (fs.existsSync(BLOBS_DIR)) {
      for (const bf of fs.readdirSync(BLOBS_DIR)) {
        if (!bf.endsWith(".blob")) continue;
        const hash = bf.slice(0, -5);
        if (!referencedBlobs.has(hash)) {
          const fullBlob = path.join(BLOBS_DIR, bf);
          try {
            const st = fs.statSync(fullBlob);
            if (forceOrphanSweep || now - st.mtimeMs > 5 * 60 * 1000) {
              freedBytes += st.size;
              fs.unlinkSync(fullBlob);
              removedBlobs++;
            }
          } catch {
            // ignore
          }
        }
      }
    }
  } catch {
    // ignore
  }

  return { purgedIds, removedBlobs, freedBytes };
}

function getDirBytes(dirPath: string): number {
  let total = 0;
  try {
    if (!fs.existsSync(dirPath)) return 0;
    for (const e of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, e.name);
      if (e.isDirectory()) {
        total += getDirBytes(full);
      } else if (e.isFile()) {
        total += fs.statSync(full).size;
      }
    }
  } catch {
    // ignore
  }
  return total;
}

export function getStorageStats(): StorageStats {
  ensureDirs();
  let blobCount = 0;
  let blobBytes = 0;
  try {
    for (const bf of fs.readdirSync(BLOBS_DIR)) {
      if (bf.endsWith(".blob")) {
        blobCount++;
        blobBytes += fs.statSync(path.join(BLOBS_DIR, bf)).size;
      }
    }
  } catch {
    // ignore
  }

  let sessionCount = 0;
  let sessionBytes = 0;
  try {
    for (const e of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
      if (e.isDirectory()) {
        sessionCount++;
        sessionBytes += getDirBytes(path.join(SESSIONS_DIR, e.name));
      }
    }
  } catch {
    // ignore
  }

  return {
    totalBytes: blobBytes + sessionBytes,
    blobCount,
    blobBytes,
    sessionCount,
    sessionBytes,
    rootDir: ".zt-storage",
  };
}

export function listStoredSessions(): StoredSessionSummary[] {
  ensureDirs();
  const out: StoredSessionSummary[] = [];
  const now = Date.now();
  try {
    for (const e of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const sid = e.name;
      const dir = path.join(SESSIONS_DIR, sid);
      const metaPath = path.join(dir, "meta.json");
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = readJsonFileSafe<DiskSessionMeta>(metaPath);
        if (!meta) continue;
        const lastSeen = Number(meta.lastSeen) || Number(meta.createdAt) || now;
        const expiresAt = Number(meta.expiresAt) || lastSeen + SESSION_TTL_MS;
        if (now >= expiresAt && now - lastSeen >= SESSION_TTL_MS) continue;

        let messageCount = 0;
        let firstPrompt: string | undefined = undefined;
        const dispPath = path.join(dir, "display.jsonl");
        if (fs.existsSync(dispPath)) {
          const dispLines = fs
            .readFileSync(dispPath, "utf-8")
            .split("\n")
            .filter((l) => l.trim());
          messageCount = dispLines.length;
          if (dispLines.length > 0) {
            try {
              const firstObj = JSON.parse(dispLines[0]) as DisplayMessage;
              if (firstObj?.text) firstPrompt = firstObj.text;
            } catch {
              // ignore
            }
          }
        }
        if (messageCount === 0) {
          const histPath = path.join(dir, "history.jsonl");
          if (fs.existsSync(histPath)) {
            messageCount = fs
              .readFileSync(histPath, "utf-8")
              .split("\n")
              .filter((l) => l.trim()).length;
          }
        }

        let pendingProposals = 0;
        const propsDir = path.join(dir, "proposals");
        if (fs.existsSync(propsDir)) {
          pendingProposals = fs
            .readdirSync(propsDir)
            .filter((f) => f.endsWith(".json")).length;
        }
        let checkpoints = 0;
        const cpDir = path.join(dir, "checkpoints");
        if (fs.existsSync(cpDir)) {
          checkpoints = fs
            .readdirSync(cpDir)
            .filter((f) => f.endsWith(".json")).length;
        }

        // Skip empty unlocked ghost sessions so the session switcher only shows meaningful sessions
        const isGhostSession =
          !meta.root &&
          messageCount === 0 &&
          pendingProposals === 0 &&
          checkpoints === 0 &&
          (!meta.title || meta.title === "Untitled Session");
        if (isGhostSession) continue;

        const title = buildDefaultSessionTitle(
          meta.root || null,
          firstPrompt,
          meta.title
        );

        out.push({
          id: meta.id || sid,
          root: meta.root || null,
          createdAt: meta.createdAt,
          expiresAt: Math.max(expiresAt, lastSeen + SESSION_TTL_MS),
          lastSeen,
          turns: Math.floor(messageCount / 2),
          messageCount,
          pendingProposals,
          checkpoints,
          title,
        });
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return out.sort((a, b) => b.lastSeen - a.lastSeen);
}