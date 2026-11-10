import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  getOrCreateSession,
  persistSessionDebounced,
} from "@/lib/session-store";
import { safeResolve } from "@/lib/security";
import {
  buildSnapshot,
  ctxInfo,
  isBinaryBuffer,
  listFiles,
  pruneEmptyParents,
  undoStepCount,
  walk,
} from "@/lib/workspace";
import { setOp } from "@/lib/proposals";
import {
  deleteCheckpointFromDisk,
  deleteProposalFromDisk,
  getStorageStats,
  hydrateCheckpointFiles,
  putBlob,
  saveCheckpointToDisk,
  saveSnapshotToDisk,
} from "@/lib/disk-store";
import type { CheckpointDiffFile } from "@/types/builder";

export async function GET(req: NextRequest) {
  const { session: s, error, status } = getOrCreateSession(
    req,
    undefined,
    true
  );
  if (!s) return NextResponse.json({ error }, { status: status || 400 });

  return NextResponse.json({
    checkpoints: (s.checkpoints || []).map((c) => ({
      id: c.id,
      name: c.name,
      ts: c.ts,
      fileCount: c.fileCount,
    })),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { session: s, error, status } = getOrCreateSession(req, body.sid);
  if (!s) return NextResponse.json({ error }, { status: status || 400 });
  if (!s.root) {
    return NextResponse.json(
      { error: "Lock a workspace folder first." },
      { status: 403 }
    );
  }

  const action = String(body.action || "create");

  if (action === "create") {
    const name =
      String(body.name || "").trim() ||
      `Checkpoint #${(s.checkpoints?.length || 0) + 1}`;
    const { files } = walk(s.root);
    const blobHashes: Record<string, string> = {};
    for (const f of files) {
      try {
        const buf = fs.readFileSync(f.full);
        if (isBinaryBuffer(buf)) continue;
        const content = buf.toString("utf-8");
        const hash = putBlob(content);
        if (hash) blobHashes[f.rel] = hash;
      } catch {
        // ignore unreadable
      }
    }

    const fileCount = Object.keys(blobHashes).length;
    const cp = {
      id: `cp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      ts: Date.now(),
      fileCount,
      files: new Map<string, string>(),
      blobHashes,
    };

    saveCheckpointToDisk(s.id, cp);
    s.checkpoints.unshift(cp);
    while (s.checkpoints.length > 20) {
      const evicted = s.checkpoints.pop();
      if (evicted) {
        deleteCheckpointFromDisk(s.id, evicted.id);
      }
    }
    s.events.push(
      `User created deduplicated disk checkpoint "${name}" (${fileCount} files).`
    );
    persistSessionDebounced(s.id, false);

    return NextResponse.json({
      ok: true,
      checkpoints: s.checkpoints.map((c) => ({
        id: c.id,
        name: c.name,
        ts: c.ts,
        fileCount: c.fileCount,
      })),
      storage: getStorageStats(),
    });
  }

  if (action === "diff") {
    const cp = s.checkpoints.find((c) => c.id === body.id);
    if (!cp) {
      return NextResponse.json(
        { error: "Checkpoint not found." },
        { status: 404 }
      );
    }

    const cpFiles = hydrateCheckpointFiles(cp);
    const { files: currentWalk } = walk(s.root);
    const currentMap = new Map<string, string>();
    for (const f of currentWalk) {
      try {
        const buf = fs.readFileSync(f.full);
        if (isBinaryBuffer(buf)) continue;
        currentMap.set(f.rel, buf.toString("utf-8"));
      } catch {
        // ignore unreadable
      }
    }

    const allPaths = Array.from(
      new Set([...currentMap.keys(), ...cpFiles.keys()])
    ).sort();
    const diffs: CheckpointDiffFile[] = [];

    for (const relPath of allPaths) {
      const cur = currentMap.get(relPath) ?? null;
      const target = cpFiles.get(relPath) ?? null;
      if (cur === target) continue;
      if (cur === null && target !== null) {
        diffs.push({
          relPath,
          status: "restore-create",
          currentContent: null,
          checkpointContent: target,
        });
      } else if (cur !== null && target === null) {
        diffs.push({
          relPath,
          status: "restore-delete",
          currentContent: cur,
          checkpointContent: null,
        });
      } else {
        diffs.push({
          relPath,
          status: "restore-modify",
          currentContent: cur,
          checkpointContent: target,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      checkpoint: {
        id: cp.id,
        name: cp.name,
        ts: cp.ts,
        fileCount: cp.fileCount,
      },
      diffs,
    });
  }

  if (action === "restore") {
    const cp = s.checkpoints.find((c) => c.id === body.id);
    if (!cp) {
      return NextResponse.json(
        { error: "Checkpoint not found." },
        { status: 404 }
      );
    }

    const cpFiles = hydrateCheckpointFiles(cp);
    const { files: currentWalk } = walk(s.root);
    const currentMap = new Map<string, string>();
    for (const f of currentWalk) {
      try {
        const buf = fs.readFileSync(f.full);
        if (!isBinaryBuffer(buf)) {
          currentMap.set(f.rel, buf.toString("utf-8"));
        }
      } catch {
        // ignore
      }
    }

    // Group all restore mutations into a single synthetic Undo turn so 1 click of Undo reverses the restore
    const restoreTurnId = -Date.now();

    for (const f of currentWalk) {
      if (!cpFiles.has(f.rel)) {
        try {
          const { resolved, rel } = safeResolve(s, f.rel);
          const prevContent = currentMap.get(f.rel) ?? null;
          if (fs.existsSync(resolved)) {
            fs.unlinkSync(resolved);
            pruneEmptyParents(s.root, path.dirname(resolved));
          }
          if (prevContent !== null) {
            s.undoStack.push({
              rel,
              prev: null,
              prevHash: putBlob(prevContent),
              turn: restoreTurnId,
            });
          }
        } catch {
          // ignore protected files
        }
      }
    }

    for (const [rel, content] of cpFiles.entries()) {
      try {
        const { resolved, rel: cleanRel } = safeResolve(s, rel);
        const prevContent = currentMap.get(cleanRel) ?? null;
        if (prevContent === content) continue;

        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, "utf-8");

        s.undoStack.push({
          rel: cleanRel,
          prev: null,
          prevHash: putBlob(prevContent),
          turn: restoreTurnId,
        });
      } catch {
        // ignore protected files
      }
    }

    while (s.undoStack.length > 300) s.undoStack.shift();

    for (const id of Object.keys(s.pendingChanges)) {
      setOp(s, id, "superseded");
      delete s.pendingChanges[id];
      deleteProposalFromDisk(s.id, id);
    }

    if (s.snapshot) {
      buildSnapshot(s, !s.readDenied);
      saveSnapshotToDisk(s.id, s.snapshot);
    } else {
      s.seen.clear();
    }

    s.events.push(
      `User restored workspace to checkpoint "${cp.name}" (${cp.fileCount} files).`
    );
    persistSessionDebounced(s.id, true);

    return NextResponse.json({
      ok: true,
      restored: cp.name,
      files: listFiles(s),
      undoCount: undoStepCount(s),
      ctx: ctxInfo(s),
      storage: getStorageStats(),
    });
  }

  return NextResponse.json({ error: "Invalid action." }, { status: 400 });
}