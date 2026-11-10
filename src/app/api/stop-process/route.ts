import { NextRequest, NextResponse } from "next/server";
import {
  getOrCreateSession,
  killAllProcs,
  persistSessionDebounced,
} from "@/lib/session-store";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { session: s, error, status } = getOrCreateSession(req, body.sid);
  if (!s) return NextResponse.json({ error }, { status: status || 400 });

  killAllProcs(s);
  s.logs += "\n[Stopped by user]\n";
  s.events.push("User stopped the running process.");
  persistSessionDebounced(s.id, false);
  return NextResponse.json({ ok: true });
}