import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  getOrCreateSession,
  persistSessionDebounced,
} from "@/lib/session-store";
import { safeResolve, sha1 } from "@/lib/security";
import {
  ensureGitignoreHasCredentials,
  isChangelogFile,
  isGitignoreFile,
  mergeChangelogAppendOnly,
  setOp,
} from "@/lib/proposals";
import {
  listFiles,
  markSeen,
  pruneEmptyParents,
  undoStepCount,
} from "@/lib/workspace";
import {
  deleteProposalFromDisk,
  getStorageStats,
  hydrateProposal,
  loadProposalFromDisk,
  putBlob,
} from "@/lib/disk-store";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { session: s, error, status } = getOrCreateSession(req, body.sid);
  if (!s) return NextResponse.json({ error }, { status: status || 400 });

  const propId = String(body.id || "");
  // Disk-first fallback: if this worker's RAM doesn't have `propId` (e.g. after reading for 15+ mins
  // or across Next.js route workers), load it directly from `.zt-storage/sessions/<sid>/proposals/`!
  let rawProp = s.pendingChanges[propId];
  if (!rawProp && propId) {
    const fromDisk = loadProposalFromDisk(s.id, propId);
    if (fromDisk) {
      rawProp = fromDisk;
      s.pendingChanges[propId] = fromDisk;
    }
  }

  if (!rawProp) {
    return NextResponse.json(
      { error: "Proposal expired or not found." },
      { status: 404 }
    );
  }
  const p = hydrateProposal(rawProp);

  // Support developer inline edits of the proposed code inside ReviewModal before saving
  const rawFinalContent =
    typeof body.customContent === "string"
      ? body.customContent
      : p.content ?? "";
  const wasEditedByUser =
    typeof body.customContent === "string" && body.customContent !== p.content;

  try {
    const { resolved, rel } = safeResolve(s, p.relPath);
    const exists = fs.existsSync(resolved) && fs.statSync(resolved).isFile();
    const prev = exists ? fs.readFileSync(resolved, "utf-8") : null;
    const curHash = prev !== null ? sha1(prev) : null;

    if (p.baseHash !== undefined && curHash !== p.baseHash && !body.force) {
      return NextResponse.json(
        {
          stale: true,
          error:
            "This file changed on disk (or was removed) after the AI proposed the change.",
        },
        { status: 409 }
      );
    }

    if (p.kind === "delete") {
      if (isChangelogFile(rel)) {
        return NextResponse.json(
          {
            error:
              "Deleting CHANGELOG.md is blocked — changelog is strictly append-only.",
          },
          { status: 403 }
        );
      }
      if (!exists) throw new Error("File no longer exists.");
      fs.unlinkSync(resolved);
      if (s.root) pruneEmptyParents(s.root, path.dirname(resolved));
      s.events.push(`User APPROVED deleting ${rel}.`);
    } else {
      let finalContent = rawFinalContent;
      if (isChangelogFile(rel) && prev !== null) {
        finalContent = mergeChangelogAppendOnly(prev, finalContent);
      }
      if (isGitignoreFile(rel)) {
        finalContent = ensureGitignoreHasCredentials(finalContent);
      }

      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, finalContent, "utf-8");
      s.events.push(
        wasEditedByUser
          ? `User EDITED and APPROVED saving ${rel}.`
          : `User APPROVED and saved ${rel} ${isChangelogFile(rel) && prev !== null ? "(appended to existing changelog)" : "exactly as proposed"}.`
      );
    }

    const prevHash = putBlob(prev);
    s.undoStack.push({
      rel,
      prev: null, // Cold storage in .zt-storage/blobs/<prevHash>.blob
      prevHash,
      turn: p.turn,
      propId: p.id,
    });
    if (s.undoStack.length > 300) s.undoStack.shift();
    setOp(s, p.id, "approved");
    delete s.pendingChanges[p.id];
    deleteProposalFromDisk(s.id, p.id);

    // If the user tweaked the proposal inline, invalidate s.seen so buildDelta()
    // sends the user's exact edited version to the AI on the next turn.
    if (wasEditedByUser) {
      if (s.snapshot && !s.readDenied) {
        s.seen.set(rel, "edited_by_user");
      }
    } else {
      markSeen(s, rel, p.kind === "delete");
    }

    persistSessionDebounced(s.id, true);

    return NextResponse.json({
      ok: true,
      files: listFiles(s),
      undoCount: undoStepCount(s),
      storage: getStorageStats(),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 403 });
  }
}