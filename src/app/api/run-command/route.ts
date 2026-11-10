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

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { session: s, error, status } = getOrCreateSession(req, body.sid);
  if (!s) return NextResponse.json({ error }, { status: status || 400 });
  if (!s.root) {
    return NextResponse.json(
      { error: "Lock a workspace folder first." },
      { status: 403 }
    );
  }

  const command = String(body.command || "").trim();
  if (!command) {
    return NextResponse.json({ error: "Empty command." }, { status: 400 });
  }

  const why = riskOf(command);
  if (why) {
    return NextResponse.json({ error: `Blocked: ${why}` }, { status: 403 });
  }

  const long = LONG_RUNNING_RE.test(command);
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
  append(`\n$ ${command}\n`);

  s.activeCmds = (s.activeCmds || 0) + 1;

  const child = spawn(command, {
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
        `User manually ran \`${command}\` (exit code ${code}).\nTerminal Output Tail:\n${out.slice(-2500)}`
      );
      persistSessionDebounced(s.id, false);
    });

    return NextResponse.json({ ok: true, started: command });
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
      append("\n[Timed out after 5 minutes]\n");
      persistSessionDebounced(s.id, false);
      finish({ error: "Command timed out.", code: 124, output: out });
    }, 300_000);

    child.on("error", (e) => {
      clearTimeout(timer);
      unregisterProc(s, child);
      append(`[spawn error] ${e.message}\n`);
      persistSessionDebounced(s.id, false);
      finish({ error: e.message, code: 1, output: out });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      unregisterProc(s, child);
      append(`[Process exited with code ${code}]\n`);
      s.events.push(
        `User manually ran \`${command}\` (exit code ${code}).\nTerminal Output Tail:\n${out.slice(-2500)}`
      );
      persistSessionDebounced(s.id, false);
      finish({ ok: true, code: code ?? 0, output: out });
    });
  });
}