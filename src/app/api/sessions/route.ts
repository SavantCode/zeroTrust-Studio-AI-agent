import { NextRequest, NextResponse } from "next/server";
import { getStorageStats, listStoredSessions } from "@/lib/disk-store";
import {
  clearAllSessionsAndStorage,
  destroySession,
  purgeExpiredSessions,
  renameSession,
} from "@/lib/session-store";

export async function GET() {
  purgeExpiredSessions(false);
  return NextResponse.json({
    sessions: listStoredSessions(),
    storage: getStorageStats(),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body.action === "gc") {
    const gc = purgeExpiredSessions(true);
    return NextResponse.json({
      ok: true,
      purgedSessions: gc.purgedSessions,
      removedBlobs: gc.removedBlobs,
      freedBytes: gc.freedBytes,
      sessions: listStoredSessions(),
      storage: getStorageStats(),
    });
  }
  if (body.action === "clear-all") {
    const res = clearAllSessionsAndStorage();
    return NextResponse.json({
      ok: true,
      clearedSessions: res.clearedSessions,
      removedBlobs: res.removedBlobs,
      freedBytes: res.freedBytes,
      sessions: listStoredSessions(),
      storage: getStorageStats(),
    });
  }
  if (body.action === "rename") {
    const targetSid = String(body.targetSid || "");
    const title = String(body.title ?? "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(targetSid)) {
      return NextResponse.json(
        { error: "Invalid session ID." },
        { status: 400 }
      );
    }
    const ok = renameSession(targetSid, title);
    if (!ok) {
      return NextResponse.json(
        { error: "Session not found." },
        { status: 404 }
      );
    }
    return NextResponse.json({
      ok: true,
      sessions: listStoredSessions(),
      storage: getStorageStats(),
    });
  }
  return NextResponse.json({ error: "Invalid action." }, { status: 400 });
}

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const targetSid = String(body.targetSid || "");
  const title = String(body.title ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(targetSid)) {
    return NextResponse.json({ error: "Invalid session ID." }, { status: 400 });
  }
  const ok = renameSession(targetSid, title);
  if (!ok) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    sessions: listStoredSessions(),
    storage: getStorageStats(),
  });
}

export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const targetSid = String(
    body.targetSid || req.nextUrl.searchParams.get("sid") || ""
  );
  if (!/^[0-9a-f-]{36}$/i.test(targetSid)) {
    return NextResponse.json({ error: "Invalid session ID." }, { status: 400 });
  }
  destroySession(targetSid);
  return NextResponse.json({
    ok: true,
    sessions: listStoredSessions(),
    storage: getStorageStats(),
  });
}