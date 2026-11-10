import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  getOrCreateSession,
  persistSessionDebounced,
} from "@/lib/session-store";
import { MAX_PROPOSAL_BYTES } from "@/lib/config";
import { safeResolve } from "@/lib/security";
import {
  ensureGitignoreHasCredentials,
  isChangelogFile,
  isGitignoreFile,
  mergeChangelogAppendOnly,
} from "@/lib/proposals";
import {
  isBinaryBuffer,
  listFiles,
  pruneEmptyParents,
  undoStepCount,
} from "@/lib/workspace";
import { getStorageStats, putBlob } from "@/lib/disk-store";

export async function GET(req: NextRequest) {
  const { session: s, error, status } = getOrCreateSession(
    req,
    undefined,
    true
  );
  if (!s) return NextResponse.json({ error }, { status: status || 400 });
  if (!s.root) {
    return NextResponse.json(
      { error: "Workspace not locked." },
      { status: 403 }
    );
  }

  const relPath = req.nextUrl.searchParams.get("path") || "";
  try {
    const { resolved, rel } = safeResolve(s, relPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return NextResponse.json({ error: "File not found." }, { status: 404 });
    }
    const stat = fs.statSync(resolved);
    if (stat.size > MAX_PROPOSAL_BYTES) {
      return NextResponse.json(
        { error: "File is larger than 2 MB." },
        { status: 413 }
      );
    }
    const buf = fs.readFileSync(resolved);
    if (isBinaryBuffer(buf)) {
      return NextResponse.json(
        {
          error:
            "This is a binary file and cannot be opened in the text code editor.",
        },
        { status: 415 }
      );
    }
    const content = buf.toString("utf-8");
    return NextResponse.json({ relPath: rel, content, size: stat.size });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 403 });
  }
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { session: s, error, status } = getOrCreateSession(req, body.sid);
  if (!s) return NextResponse.json({ error }, { status: status || 400 });
  if (!s.root) {
    return NextResponse.json(
      { error: "Workspace not locked." },
      { status: 403 }
    );
  }

  try {
    const { resolved, rel } = safeResolve(s, String(body.relPath || ""));
    let content = String(body.content ?? "");

    const exists = fs.existsSync(resolved) && fs.statSync(resolved).isFile();
    const prev = exists ? fs.readFileSync(resolved, "utf-8") : null;

    if (isChangelogFile(rel) && prev !== null) {
      content = mergeChangelogAppendOnly(prev, content);
    }
    if (isGitignoreFile(rel)) {
      content = ensureGitignoreHasCredentials(content);
    }

    const byteSize = Buffer.byteLength(content, "utf-8");
    if (byteSize > MAX_PROPOSAL_BYTES) {
      return NextResponse.json(
        { error: "File content exceeds the 2 MB sandbox editor limit." },
        { status: 413 }
      );
    }

    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf-8");

    const prevHash = putBlob(prev);
    s.undoStack.push({ rel, prev: null, prevHash });
    if (s.undoStack.length > 300) s.undoStack.shift();

    // Invalidate s.seen for this file so buildDelta() automatically sends the user's
    // manual Studio Editor changes to the AI on the next chat message.
    if (s.snapshot && !s.readDenied) {
      s.seen.set(rel, "manual_edit");
    }

    s.events.push(
      exists
        ? `User manually edited and saved ${rel} in the Studio Editor.`
        : `User manually created new file ${rel} in the Studio Editor.`
    );
    persistSessionDebounced(s.id);

    return NextResponse.json({
      ok: true,
      relPath: rel,
      size: byteSize,
      files: listFiles(s),
      undoCount: undoStepCount(s),
      storage: getStorageStats(),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 403 });
  }
}

export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { session: s, error, status } = getOrCreateSession(req, body.sid);
  if (!s) return NextResponse.json({ error }, { status: status || 400 });
  if (!s.root) {
    return NextResponse.json(
      { error: "Workspace not locked." },
      { status: 403 }
    );
  }

  try {
    const { resolved, rel } = safeResolve(s, String(body.relPath || ""));
    if (isChangelogFile(rel)) {
      return NextResponse.json(
        {
          error:
            "Deleting CHANGELOG.md is blocked — changelog history is append-only.",
        },
        { status: 403 }
      );
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return NextResponse.json({ error: "File not found." }, { status: 404 });
    }
    const prev = fs.readFileSync(resolved, "utf-8");
    fs.unlinkSync(resolved);
    pruneEmptyParents(s.root, path.dirname(resolved));

    const prevHash = putBlob(prev);
    s.undoStack.push({ rel, prev: null, prevHash });
    if (s.undoStack.length > 300) s.undoStack.shift();

    // Ensure rel is recorded in s.seen so buildDelta() detects that it was deleted from disk
    if (s.snapshot && !s.readDenied && !s.seen.has(rel)) {
      s.seen.set(rel, "deleted_by_user");
    }

    s.events.push(`User manually deleted ${rel}.`);
    persistSessionDebounced(s.id);

    return NextResponse.json({
      ok: true,
      deleted: rel,
      files: listFiles(s),
      undoCount: undoStepCount(s),
      storage: getStorageStats(),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 403 });
  }
}