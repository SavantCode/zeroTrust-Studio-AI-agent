import fs from "fs";
import path from "path";
import {
  DELTA_CHAR_BUDGET,
  IGNORE_DIRS,
  isReadable,
  MAX_FILE_BYTES,
  priority,
  SNAPSHOT_CHAR_BUDGET,
} from "./config";
import type { BuilderSession, ContextInfo } from "@/types/builder";

export interface WalkFileItem {
  rel: string;
  full: string;
  size: number;
  sig: string;
}

export function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function pruneEmptyParents(root: string, startDir: string): void {
  try {
    const resolvedRoot = path.resolve(root);
    let cur = path.resolve(startDir);
    while (
      cur !== resolvedRoot &&
      cur.startsWith(resolvedRoot + path.sep) &&
      fs.existsSync(cur)
    ) {
      const entries = fs.readdirSync(cur);
      if (entries.length === 0) {
        fs.rmdirSync(cur);
        cur = path.dirname(cur);
      } else {
        break;
      }
    }
  } catch {
    // ignore permission or race errors
  }
}

export function walk(root: string): { files: WalkFileItem[]; skipped: string[] } {
  const files: WalkFileItem[] = [];
  const skipped: string[] = [];

  function rec(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) rec(full);
      } else if (e.isFile() && isReadable(e.name)) {
        let st: fs.Stats;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        const rel = path.relative(root, full).replace(/\\/g, "/");
        if (st.size > MAX_FILE_BYTES) {
          skipped.push(rel);
          continue;
        }
        files.push({
          rel,
          full,
          size: st.size,
          sig: `${st.mtimeMs}:${st.size}`,
        });
      }
    }
  }

  rec(root);
  return { files, skipped };
}

export function listFiles(s: BuilderSession): string[] {
  if (!s.root) return [];
  return walk(s.root)
    .files.map((f) => f.rel)
    .sort();
}

export function buildSnapshot(s: BuilderSession, allowRead: boolean): void {
  s.seen = new Map();
  s.readDenied = !allowRead;
  if (!allowRead || !s.root) {
    s.snapshot = {
      text: "=== PROJECT SNAPSHOT ===\n(The user denied file-read permission for this session. You cannot see existing files.)\n",
      count: 0,
      omitted: [],
    };
    return;
  }

  const { files, skipped } = walk(s.root);
  files.sort((a, b) => priority(a.rel) - priority(b.rel) || a.size - b.size);

  let text =
    "=== PROJECT SNAPSHOT (read once, kept in context for this whole session) ===\nFile list:\n";
  text +=
    (files.map((f) => f.rel).sort().join("\n") || "(workspace is empty)") + "\n";

  let used = 0;
  let count = 0;
  const omitted: string[] = [];

  for (const f of files) {
    s.seen.set(f.rel, f.sig);
    let c: string;
    try {
      const buf = fs.readFileSync(f.full);
      if (isBinaryBuffer(buf)) continue;
      c = buf.toString("utf-8");
    } catch {
      continue;
    }
    if (used + c.length > SNAPSHOT_CHAR_BUDGET) {
      omitted.push(f.rel);
      continue;
    }
    used += c.length;
    count++;
    text += `\n--- FILE: ${f.rel} ---\n${c}\n`;
  }

  if (omitted.length) {
    text += `\n(Listed but not included because of the size budget: ${omitted.join(", ")})\n`;
  }
  if (skipped.length) {
    text += `\n(Skipped as too large: ${skipped.join(", ")})\n`;
  }

  s.snapshot = { text, count, omitted };
}

export function buildDelta(s: BuilderSession): string | null {
  if (!s.root) return null;
  const { files } = walk(s.root);
  const cur = new Map(files.map((f) => [f.rel, f]));
  const changed = files
    .filter((f) => s.seen.get(f.rel) !== f.sig)
    .sort((a, b) => priority(a.rel) - priority(b.rel) || a.size - b.size);
  const removed = [...s.seen.keys()].filter((k) => !cur.has(k));

  if (!changed.length && !removed.length) return null;

  let text =
    "=== WORKSPACE CHANGES SINCE LAST MESSAGE (made outside this chat) ===\n";
  let used = 0;

  for (const f of changed) {
    s.seen.set(f.rel, f.sig);
    let c: string;
    try {
      const buf = fs.readFileSync(f.full);
      if (isBinaryBuffer(buf)) continue;
      c = buf.toString("utf-8");
    } catch {
      continue;
    }
    if (used + c.length > DELTA_CHAR_BUDGET) {
      text += `\n(changed, too large to include: ${f.rel})\n`;
      continue;
    }
    used += c.length;
    text += `\n--- UPDATED/NEW FILE: ${f.rel} ---\n${c}\n`;
  }

  for (const r of removed) {
    s.seen.delete(r);
    text += `\n--- DELETED FILE: ${r} ---\n`;
  }

  return text;
}

export function markSeen(s: BuilderSession, rel: string, deleted: boolean): void {
  if (!s.snapshot || s.readDenied || !s.root) return;
  if (deleted) {
    s.seen.delete(rel);
    return;
  }
  try {
    const full = path.join(s.root, rel);
    const st = fs.statSync(full);
    if (isReadable(path.basename(rel)) && st.size <= MAX_FILE_BYTES) {
      s.seen.set(rel, `${st.mtimeMs}:${st.size}`);
    }
  } catch {
    // ignore
  }
}

export function undoStepCount(s: BuilderSession): number {
  let steps = 0;
  const seenTurns = new Set<number>();
  for (const item of s.undoStack) {
    if (item.turn !== undefined) {
      if (!seenTurns.has(item.turn)) {
        seenTurns.add(item.turn);
        steps++;
      }
    } else {
      steps++;
    }
  }
  return steps;
}

export const historyChars = (s: BuilderSession): number =>
  s.history.reduce((n, m) => n + (m.parts[0]?.text?.length || 0), 0);

export const estChars = (s: BuilderSession): number =>
  (s.snapshot ? s.snapshot.text.length : 0) + historyChars(s);

export const ctxInfo = (s: BuilderSession): ContextInfo => ({
  loaded: !!s.snapshot,
  denied: s.readDenied,
  files: s.snapshot ? s.snapshot.count : 0,
  tokens: Math.round(estChars(s) / 4),
  omitted: s.snapshot ? s.snapshot.omitted.length : 0,
});