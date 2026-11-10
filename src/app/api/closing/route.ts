import { NextRequest, NextResponse } from "next/server";
import { SESSION_TTL_MS } from "@/lib/config";
import { persistSessionDebounced, sessions } from "@/lib/session-store";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const sid = String(req.headers.get("x-session-id") || body.sid || "");
  const s = sessions.get(sid);
  if (s) {
    // Keep session stored for its 24-hour TTL window and flush only metadata for this session
    const now = Date.now();
    s.lastSeen = now;
    s.expiresAt = now + SESSION_TTL_MS;
    s.closeAt = null;
    persistSessionDebounced(s.id, false);
  }
  return NextResponse.json({ ok: true });
}