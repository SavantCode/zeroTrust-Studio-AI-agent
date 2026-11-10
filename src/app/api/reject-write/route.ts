import { NextRequest, NextResponse } from "next/server";
import {
  getOrCreateSession,
  persistSessionDebounced,
} from "@/lib/session-store";
import { setOp } from "@/lib/proposals";
import { deleteProposalFromDisk } from "@/lib/disk-store";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { session: s, error, status } = getOrCreateSession(req, body.sid);
  if (!s) return NextResponse.json({ error }, { status: status || 400 });

  const p = s.pendingChanges[body.id];
  if (p) {
    s.events.push(
      `User DENIED ${p.kind === "delete" ? "deleting " : "writing "}${p.relPath} (file left unchanged).`
    );
    setOp(s, p.id, "denied");
    delete s.pendingChanges[p.id];
    deleteProposalFromDisk(s.id, p.id);
    persistSessionDebounced(s.id, true);
  }
  return NextResponse.json({ ok: true });
}