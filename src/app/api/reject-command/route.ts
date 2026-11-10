import { NextRequest, NextResponse } from "next/server";
import {
  getOrCreateSession,
  persistSessionDebounced,
} from "@/lib/session-store";
import { setOp } from "@/lib/proposals";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { session: s, error, status } = getOrCreateSession(req, body.sid);
  if (!s) return NextResponse.json({ error }, { status: status || 400 });

  const c = s.pendingCommands[body.id];
  if (c) {
    s.events.push(`User DENIED running \`${c.command}\`.`);
    setOp(s, c.id, "denied");
    delete s.pendingCommands[c.id];
    persistSessionDebounced(s.id, true);
  }
  return NextResponse.json({ ok: true });
}