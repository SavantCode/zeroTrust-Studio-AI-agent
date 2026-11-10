import { NextRequest, NextResponse } from "next/server";
import {
  getOrCreateSession,
  persistSessionDebounced,
} from "@/lib/session-store";
import { buildSnapshot, ctxInfo } from "@/lib/workspace";
import { getStorageStats, saveSnapshotToDisk } from "@/lib/disk-store";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { session: s, error, status } = getOrCreateSession(req, body.sid);
  if (!s) return NextResponse.json({ error }, { status: status || 400 });

  if (!s.root) {
    return NextResponse.json(
      { error: "Lock a workspace first." },
      { status: 403 }
    );
  }
  buildSnapshot(s, body.allowRead !== false);
  saveSnapshotToDisk(s.id, s.snapshot);
  s.events.push("(The project snapshot was refreshed from disk.)");
  persistSessionDebounced(s.id, false);
  return NextResponse.json({
    ok: true,
    ctx: ctxInfo(s),
    storage: getStorageStats(),
  });
}