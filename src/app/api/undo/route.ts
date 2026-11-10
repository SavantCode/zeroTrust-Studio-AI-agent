import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  getOrCreateSession,
  persistSessionDebounced,
} from "@/lib/session-store";
import { safeResolve } from "@/lib/security";
import {
  listFiles,
  pruneEmptyParents,
  undoStepCount,
} from "@/lib/workspace";
import { getBlob, getStorageStats } from "@/lib/disk-store";
import type { UndoItem } from "@/types/builder";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { session: s, error, status } = getOrCreateSession(req, body.sid);
  if (!s) return NextResponse.json({ error }, { status: status || 400 });

  const top = s.undoStack.pop();
  if (!top) {
    return NextResponse.json({ error: "Nothing to undo." }, { status: 400 });
  }

  // Group all file changes from the same turn so 1 Undo reverses the entire turn's writes
  const batch: UndoItem[] = [top];
  if (top.turn !== undefined) {
    for (let i = s.undoStack.length - 1; i >= 0; i--) {
      if (s.undoStack[i].turn === top.turn) {
        batch.push(s.undoStack[i]);
        s.undoStack.splice(i, 1);
      }
    }
  }

  try {
    const undoneFiles: string[] = [];
    const undoneIds: string[] = [];

    for (const u of batch) {
      const { resolved, rel } = safeResolve(s, u.rel);
      const prevContent =
        u.prev !== null && u.prev !== undefined
          ? u.prev
          : u.prevHash
            ? getBlob(u.prevHash)
            : null;

      if (prevContent === null) {
        if (fs.existsSync(resolved)) {
          fs.unlinkSync(resolved);
          if (s.root) pruneEmptyParents(s.root, path.dirname(resolved));
        }
        // Keep a placeholder in s.seen so buildDelta() reports the file as deleted to the AI
        if (s.snapshot && !s.readDenied) {
          s.seen.set(rel, "reverted_to_deleted");
        }
      } else {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, prevContent, "utf-8");
        // Invalidate s.seen signature so buildDelta() sends the reverted file content to the AI
        if (s.snapshot && !s.readDenied) {
          s.seen.set(rel, "reverted_by_undo");
        }
      }

      if (!undoneFiles.includes(rel)) {
        undoneFiles.push(rel);
      }
      if (u.propId) {
        undoneIds.push(u.propId);
      }

      // Mark corresponding operation chip in display history as "undone"
      let marked = false;
      if (u.propId) {
        for (let i = s.display.length - 1; i >= 0; i--) {
          for (const o of s.display[i].ops || []) {
            if (o.id === u.propId && o.status === "approved") {
              o.status = "undone";
              marked = true;
              break;
            }
          }
          if (marked) break;
        }
      }
      if (!marked) {
        outer: for (let i = s.display.length - 1; i >= 0; i--) {
          for (const o of [...(s.display[i].ops || [])].reverse()) {
            if (o.relPath === rel && o.status === "approved") {
              o.status = "undone";
              break outer;
            }
          }
        }
      }
    }

    if (top.turn !== undefined && top.turn > 0) {
      s.events.push(
        `User UNDID all ${undoneFiles.length} file change(s) from Turn #${top.turn} (${undoneFiles.join(", ")} reverted).`
      );
    } else {
      s.events.push(
        `User UNDID the change to ${undoneFiles.join(", ")} (reverted).`
      );
    }

    persistSessionDebounced(s.id);

    return NextResponse.json({
      ok: true,
      undone: undoneFiles[0] || top.rel,
      undoneFiles,
      undoneIds,
      turn: top.turn ?? null,
      files: listFiles(s),
      undoCount: undoStepCount(s),
      storage: getStorageStats(),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 403 });
  }
}