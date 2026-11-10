import { NextRequest, NextResponse } from "next/server";
import {
  getOrCreateSession,
  persistSessionDebounced,
} from "@/lib/session-store";
import {
  clearSessionChatLogsOnDisk,
  deleteProposalFromDisk,
  getStorageStats,
} from "@/lib/disk-store";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { session: s, error, status } = getOrCreateSession(req, body.sid);
  if (!s) return NextResponse.json({ error }, { status: status || 400 });

  if (s.busy) {
    return NextResponse.json(
      { error: "Wait for the current reply to finish." },
      { status: 409 }
    );
  }

  const last = [...s.display].reverse().find((m) => m.role === "model");
  const lastUser = [...s.display].reverse().find((m) => m.role === "user");
  if (!last || !lastUser) {
    return NextResponse.json({ error: "Nothing to retry." }, { status: 400 });
  }

  const ops = last.ops || [];
  const applied = ops.filter(
    (o) => o.status === "approved" || o.status === "ran"
  ).length;
  if (applied && !body.force) {
    return NextResponse.json(
      {
        approvedOps: applied,
        error: "Some changes from that reply were already applied.",
      },
      { status: 409 }
    );
  }

  const removedIds: string[] = [];
  for (const o of ops) {
    if (s.pendingChanges[o.id]) {
      delete s.pendingChanges[o.id];
      deleteProposalFromDisk(s.id, o.id);
      removedIds.push(o.id);
    }
    if (s.pendingCommands[o.id]) {
      delete s.pendingCommands[o.id];
      removedIds.push(o.id);
    }
    if (o.status === "approved" && o.relPath) {
      s.seen.delete(o.relPath);
    }
  }

  // Safely remove the last user + model pair
  if (s.display.length >= 2) {
    s.display.splice(-2);
  } else {
    s.display = [];
  }
  if (s.history.length >= 2) {
    s.history.splice(-2);
  } else {
    s.history = [];
  }

  // If the first turn was undone leaving 0 messages, explicitly clear the JSONL files
  // so writeChatLogsToDisk() knows this was an intentional clear rather than an unhydrated session.
  if (s.display.length === 0 && s.history.length === 0) {
    clearSessionChatLogsOnDisk(s.id);
  }

  persistSessionDebounced(s.id, true);

  return NextResponse.json({
    ok: true,
    prompt: lastUser.text,
    mode: lastUser.mode || "build",
    removedIds,
    turns: Math.floor(s.history.length / 2),
    storage: getStorageStats(),
  });
}