import { NextRequest, NextResponse } from "next/server";
import {
  getOrCreateSession,
  persistSessionDebounced,
} from "@/lib/session-store";

export async function GET(req: NextRequest) {
  const { session: s, error, status } = getOrCreateSession(
    req,
    undefined,
    true
  );
  if (!s) return NextResponse.json({ error }, { status: status || 400 });

  return NextResponse.json({
    root: s.root,
    logs: s.logs,
    previewUrl: s.previewUrl,
    running: Boolean(
      s.proc || (s.procs && s.procs.size > 0) || s.activeCmds > 0
    ),
  });
}

export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { session: s, error, status } = getOrCreateSession(req, body.sid);
  if (!s) return NextResponse.json({ error }, { status: status || 400 });

  s.logs = "";
  persistSessionDebounced(s.id, false);
  return NextResponse.json({ ok: true });
}