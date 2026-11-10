import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import {
  getOrCreateSession,
  killTree,
  persistSessionDebounced,
  registerProc,
  unregisterProc,
} from "@/lib/session-store";
import {
  ANSI_RE,
  extractPreviewUrl,
  LONG_RUNNING_RE,
  riskOf,
  safeEnv,
} from "@/lib/security";
import { setOp } from "@/lib/proposals";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { session: s, error, status } = getOrCreateSession(req, body.sid);
  if (!s) return NextResponse.json({ error }, { status: status || 400 });
  if (!s.root) {
    return NextResponse.json({ error: "No workspace locked." }, { status: 403 });
  }

  const c = s.pendingCommands[body.id];
  if (!c) {
    return NextResponse.json(
      { error: "Command proposal not found." },
      { status: 404 }
    );
  }

  const why = riskOf(c.command);
  if (why) {
    return NextResponse.json({ error: `Blocked: ${why}` }, { status: 403 });
  }

  setOp(s, c.id, "ran");
  delete s.pendingCommands[c.id];
  persistSessionDebounced(s.id, true);

  const long = LONG_RUNNING_RE.test(c.command);
  if (long) {
    if (s.proc) {
      killTree(s.proc);
      unregisterProc(s, s.proc);
    }
    s.previewUrl = null;
  }

  const append = (t: string) => {
    s.logs = (s.logs + t).slice(-60_000);
  };
  append(`\n$ ${c.command}\n`);

  s.activeCmds = (s.activeCmds || 0) + 1;

  const child = spawn(c.command, {
    cwd: s.root,
    shell: true,
    env: safeEnv(),
    detached: process.platform !== "win32",
  });
  registerProc(s, child, long);

  let out = "";
  const wait = Boolean(body.wait && !long);

  const onData = (d: Buffer) => {
    const t = d.toString().replace(ANSI_RE, "");
    out = (out + t).slice(-6000);
    append(t);
    const detectedUrl = extractPreviewUrl(out);
    if (detectedUrl) s.previewUrl = detectedUrl;
  };

  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  if (!wait) {
    child.on("error", (e) => {
      unregisterProc(s, child);
      append(`[spawn error] ${e.message}\n`);
      persistSessionDebounced(s.id, false);
    });
    child.on("close", (code) => {
      unregisterProc(s, child);
      append(`[Process exited with code ${code}]\n`);
      s.events.push(
        `Command \`${c.command}\` finished with exit code ${code}.\nTerminal Output Tail:\n${out.slice(-2500)}`
      );
      persistSessionDebounced(s.id, false);
    });
    return NextResponse.json({ ok: true, started: c.command });
  }

  return new Promise<NextResponse>((resolve) => {
    let settled = false;
    const finish = (payload: Record<string, unknown>) => {
      if (!settled) {
        settled = true;
        resolve(NextResponse.json(payload));
      }
    };
    const timer = setTimeout(() => {
      killTree(child);
      unregisterProc(s, child);
      append("\n[Timed out after 10 minutes]\n");
      s.events.push(`Command \`${c.command}\` timed out after 10 minutes.`);
      persistSessionDebounced(s.id, false);
      finish({ error: "Command timed out after 10 minutes." });
    }, 600_000);

    child.on("error", (e) => {
      clearTimeout(timer);
      unregisterProc(s, child);
      append(`[spawn error] ${e.message}\n`);
      persistSessionDebounced(s.id, false);
      finish({ error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      unregisterProc(s, child);
      append(`[Process exited with code ${code}]\n`);
      s.events.push(
        `Command \`${c.command}\` finished with exit code ${code}.\nTerminal Output Tail:\n${out.slice(-2500)}`
      );
      persistSessionDebounced(s.id, false);
      finish({ ok: true, code });
    });
  });
}