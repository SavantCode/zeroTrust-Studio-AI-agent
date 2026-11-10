import { NextRequest, NextResponse } from "next/server";
import {
  getOrCreateSession,
  persistSessionDebounced,
} from "@/lib/session-store";
import { ctxInfo } from "@/lib/workspace";
import { SESSION_TTL_MS } from "@/lib/config";
import {
  clearSessionAttachmentsOnDisk,
  clearSessionChatLogsOnDisk,
  clearSessionProposalsOnDisk,
  getStorageStats,
  saveSessionToDisk,
} from "@/lib/disk-store";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { session: s, error, status } = getOrCreateSession(req, body.sid);
  if (!s) return NextResponse.json({ error }, { status: status || 400 });

  const now = Date.now();
  s.createdAt = now;
  s.expiresAt = now + SESSION_TTL_MS;
  s.history = [];
  s.display = [];
  s.events = [];
  s.pendingChanges = {};
  s.pendingCommands = {};
  s.snapshot = null;
  s.seen = new Map();
  s.readDenied = false;
  s.usage = { prompt: 0, output: 0, cached: 0, last: null };

  clearSessionChatLogsOnDisk(s.id);
  clearSessionProposalsOnDisk(s.id);
  clearSessionAttachmentsOnDisk(s.id);
  saveSessionToDisk(s);
  persistSessionDebounced(s.id, true);

  return NextResponse.json({
    ok: true,
    ctx: ctxInfo(s),
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    storage: getStorageStats(),
  });
}