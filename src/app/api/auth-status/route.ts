import { NextRequest, NextResponse } from "next/server";
import { getVertexAuthHealthStatus } from "@/lib/config";
import { getOrCreateSession } from "@/lib/session-store";

export async function GET(req: NextRequest) {
  const reload = req.nextUrl.searchParams.get("reload") === "1";
  const { session: s } = getOrCreateSession(req, undefined, true);
  const auth = getVertexAuthHealthStatus(s?.root || null, reload);
  return NextResponse.json(auth);
}