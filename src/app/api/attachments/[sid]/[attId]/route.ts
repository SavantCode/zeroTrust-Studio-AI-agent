import { NextRequest, NextResponse } from "next/server";
import { readAttachmentFromDisk } from "@/lib/disk-store";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ sid: string; attId: string }> }
) {
  const { sid, attId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(sid)) {
    return new NextResponse("Invalid session ID.", { status: 400 });
  }
  const att = readAttachmentFromDisk(sid, attId);
  if (!att) {
    return new NextResponse("Attachment not found.", { status: 404 });
  }
  return new NextResponse(new Uint8Array(att.buf), {
    headers: {
      "Content-Type": att.mime,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}