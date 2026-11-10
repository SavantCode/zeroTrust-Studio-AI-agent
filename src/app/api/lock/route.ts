import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";
import { getOrCreateSession, killAllProcs } from "@/lib/session-store";
import { SYSTEM_DIR_RE } from "@/lib/security";
import { ensureGitignoreHasCredentials } from "@/lib/proposals";
import { listFiles } from "@/lib/workspace";
import {
  clearSessionAttachmentsOnDisk,
  clearSessionChatLogsOnDisk,
  clearSessionProposalsOnDisk,
  findLatestSessionByRoot,
  normalizeRootPath,
  saveSessionToDisk,
} from "@/lib/disk-store";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { session: s, error, status } = getOrCreateSession(req, body.sid);
  if (!s) return NextResponse.json({ error }, { status: status || 400 });

  const { folderPath, allowCreateFolder, freshSession } = body;
  if (!folderPath) {
    return NextResponse.json(
      { error: "Folder path is required." },
      { status: 400 }
    );
  }
  if (
    typeof folderPath !== "string" ||
    folderPath.length > 500 ||
    folderPath.includes("\0")
  ) {
    return NextResponse.json(
      { error: "Invalid folder path." },
      { status: 400 }
    );
  }

  const resolved = path.resolve(String(folderPath).trim());
  if (SYSTEM_DIR_RE.test(resolved)) {
    return NextResponse.json(
      { error: "Refusing to lock a system folder." },
      { status: 400 }
    );
  }
  if (resolved === path.parse(resolved).root || resolved === os.homedir()) {
    return NextResponse.json(
      {
        error:
          "Refusing to lock a drive root or your home folder. Pick a project folder.",
      },
      { status: 400 }
    );
  }

  const exists = fs.existsSync(resolved);
  if (!exists && !allowCreateFolder) {
    return NextResponse.json({
      needsFolderCreationPermission: true,
      resolvedPath: resolved,
    });
  }
  if (!exists) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  if (!fs.statSync(resolved).isDirectory()) {
    return NextResponse.json(
      { error: "That path is a file, not a folder." },
      { status: 400 }
    );
  }

  // Ensure .gitignore in the workspace always protects vertex_credentials.json
  try {
    const gitignorePath = path.join(resolved, ".gitignore");
    if (fs.existsSync(gitignorePath) && fs.statSync(gitignorePath).isFile()) {
      const existingGi = fs.readFileSync(gitignorePath, "utf-8");
      const updatedGi = ensureGitignoreHasCredentials(existingGi);
      if (updatedGi !== existingGi) {
        fs.writeFileSync(gitignorePath, updatedGi, "utf-8");
      }
    } else if (!exists) {
      fs.writeFileSync(
        gitignorePath,
        ensureGitignoreHasCredentials(
          "node_modules/\n.next/\ndist/\nbuild/\n.env*\n!.env.example\n"
        ),
        "utf-8"
      );
    }
  } catch {
    // ignore permission errors
  }

  const isSameRoot =
    s.root !== null &&
    normalizeRootPath(s.root) === normalizeRootPath(resolved);

  // Case 1: Re-locking the exact same folder on the current session -> preserve history!
  if (isSameRoot && !freshSession) {
    s.root = resolved;
    s.logs =
      (s.logs ? s.logs + "\n" : "") + `🔒 Workspace confirmed: ${resolved}\n`;
    saveSessionToDisk(s);
    return NextResponse.json({
      locked: true,
      resumedHistory: s.display.length > 0,
      turns: Math.floor(s.history.length / 2),
      workspace: resolved,
      files: listFiles(s),
    });
  }

  killAllProcs(s);

  // Case 2: User picked a folder that has saved history in .zt-storage/sessions/ -> auto-restore it!
  const previousForFolder = !freshSession
    ? findLatestSessionByRoot(resolved, s.id)
    : null;

  if (
    previousForFolder &&
    (previousForFolder.display.length > 0 ||
      previousForFolder.history.length > 0 ||
      previousForFolder.checkpoints.length > 0 ||
      previousForFolder.undoStack.length > 0)
  ) {
    Object.assign(s, {
      root: resolved,
      title: previousForFolder.title || `📁 ${path.basename(resolved)}`,
      history: previousForFolder.history,
      display: previousForFolder.display,
      snapshot: previousForFolder.snapshot,
      seen: new Map(previousForFolder.seen),
      readDenied: previousForFolder.readDenied,
      events: [
        ...previousForFolder.events,
        `Resumed saved project history for folder: ${resolved}`,
      ],
      pendingChanges: previousForFolder.pendingChanges,
      pendingCommands: previousForFolder.pendingCommands,
      undoStack: previousForFolder.undoStack,
      checkpoints: previousForFolder.checkpoints,
      activeCmds: 0,
      previewUrl: null,
      logs:
        (previousForFolder.logs ? previousForFolder.logs + "\n" : "") +
        `🔒 Resumed workspace & chat history (${Math.floor(previousForFolder.history.length / 2)} turns) for: ${resolved}\n`,
      usage: previousForFolder.usage,
    });

    saveSessionToDisk(s);

    return NextResponse.json({
      locked: true,
      resumedHistory: true,
      resumedFromSid: previousForFolder.id,
      turns: Math.floor(s.history.length / 2),
      workspace: resolved,
      files: listFiles(s),
    });
  }

  // Case 3: Brand new folder or explicit freshSession reset
  clearSessionChatLogsOnDisk(s.id);
  clearSessionProposalsOnDisk(s.id);
  clearSessionAttachmentsOnDisk(s.id);

  Object.assign(s, {
    root: resolved,
    title: `📁 ${path.basename(resolved)}`,
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
    activeCmds: 0,
    previewUrl: null,
    logs: `🔒 Terminal locked to: ${resolved}\n`,
    usage: { prompt: 0, output: 0, cached: 0, last: null },
  });

  saveSessionToDisk(s);

  return NextResponse.json({
    locked: true,
    resumedHistory: false,
    turns: 0,
    workspace: resolved,
    files: listFiles(s),
  });
}