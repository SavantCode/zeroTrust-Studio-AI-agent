import { NextRequest, NextResponse } from "next/server";
import { getOrCreateSession } from "@/lib/session-store";
import { ctxInfo, listFiles, undoStepCount } from "@/lib/workspace";
import { MODEL, SESSION_TTL_MS, TAG_KEY } from "@/lib/config";
import {
  getStorageStats,
  hydrateProposal,
  listStoredSessions,
} from "@/lib/disk-store";

export async function GET(req: NextRequest) {
  const { session: s, error, status } = getOrCreateSession(
    req,
    undefined,
    true
  );
  if (!s) return NextResponse.json({ error }, { status: status || 400 });

  const proposals = Object.values(s.pendingChanges).map((p) =>
    hydrateProposal({ ...p })
  );

  // If the current browser tab opened a brand-new empty session ID, expose the most recent
  // saved session with history so the user can see or resume their previous work immediately.
  const stored = listStoredSessions();
  const suggestedResumeSession =
    !s.root && s.display.length === 0
      ? stored.find((item) => item.id !== s.id && (item.turns > 0 || item.root))
      : null;

  return NextResponse.json({
    sid: s.id,
    title: s.title || null,
    root: s.root,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt || s.createdAt + SESSION_TTL_MS,
    ttlMs: SESSION_TTL_MS,
    storage: getStorageStats(),
    suggestedResumeSession: suggestedResumeSession || null,
    files: s.root ? listFiles(s) : [],
    display: s.display,
    ctx: ctxInfo(s),
    proposals,
    commands: Object.values(s.pendingCommands),
    checkpoints: (s.checkpoints || []).map((c) => ({
      id: c.id,
      name: c.name,
      ts: c.ts,
      fileCount: c.fileCount,
    })),
    logs: s.logs,
    previewUrl: s.previewUrl,
    turns: Math.floor(s.history.length / 2),
    usage: s.usage,
    undoCount: undoStepCount(s),
    model: MODEL,
    tagKey: TAG_KEY,
  });
}