import { NextRequest, NextResponse } from "next/server";
import { getOrCreateSession } from "@/lib/session-store";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { session: s, error, status } = getOrCreateSession(req, body.sid);
  if (!s) return NextResponse.json({ error }, { status: status || 400 });

  s.abort?.abort();
  return NextResponse.json({ ok: true });
}