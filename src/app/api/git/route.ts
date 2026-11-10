import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  getOrCreateSession,
  persistSessionDebounced,
} from "@/lib/session-store";
import { isSecretCredentialFile } from "@/lib/config";
import { ensureGitignoreHasCredentials } from "@/lib/proposals";
import { safeEnv } from "@/lib/security";

const execFileAsync = promisify(execFile);

const GIT_UNSTAGE_SECRETS = [
  "vertex_credentials.json",
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  ".env.development.local",
  ".env.production.local",
  ".env.test.local",
];

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: safeEnv(),
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout;
}

function enforceWorkspaceGitignoreForSecrets(root: string): void {
  try {
    const giPath = path.join(root, ".gitignore");
    const existing =
      fs.existsSync(giPath) && fs.statSync(giPath).isFile()
        ? fs.readFileSync(giPath, "utf-8")
        : "node_modules/\n.next/\ndist/\nbuild/\n";
    const updated = ensureGitignoreHasCredentials(existing);
    if (!fs.existsSync(giPath) || updated !== existing) {
      fs.writeFileSync(giPath, updated, "utf-8");
    }
  } catch {
    // ignore permission errors
  }
}

async function unstageProtectedSecrets(root: string): Promise<void> {
  try {
    await runGit(root, ["reset", "-q", "--", ...GIT_UNSTAGE_SECRETS]);
  } catch {
    // ignore if unborn HEAD or files not in index
    try {
      await runGit(root, [
        "rm",
        "--cached",
        "-q",
        "--ignore-unmatch",
        "--",
        ...GIT_UNSTAGE_SECRETS,
      ]);
    } catch {
      // ignore
    }
  }
}

export async function GET(req: NextRequest) {
  const { session: s, error, status } = getOrCreateSession(
    req,
    undefined,
    true
  );
  if (!s) return NextResponse.json({ error }, { status: status || 400 });
  if (!s.root) {
    return NextResponse.json({ isRepo: false, branch: null, changes: [] });
  }

  try {
    const inside = (
      await runGit(s.root, ["rev-parse", "--is-inside-work-tree"])
    ).trim();
    if (inside !== "true") {
      return NextResponse.json({ isRepo: false, branch: null, changes: [] });
    }

    let branch = "HEAD";
    try {
      branch =
        (await runGit(s.root, ["branch", "--show-current"])).trim() || "HEAD";
    } catch {
      // detached or unborn HEAD
    }

    let branches: string[] = [];
    try {
      const rawBranches = await runGit(s.root, [
        "branch",
        "--format=%(refname:short)",
      ]);
      branches = rawBranches
        .split("\n")
        .map((b) => b.trim())
        .filter(Boolean);
    } catch {
      // ignore
    }

    const statusOut = await runGit(s.root, ["status", "--porcelain"]);
    const changes = statusOut
      .split(/\r?\n/)
      .filter((l) => l.length >= 4)
      .map((line) => {
        const xy = line.slice(0, 2).trim() || "M";
        const rawPath = line.slice(3).trim();
        const arrowIdx = rawPath.indexOf(" -> ");
        const cleanPath =
          arrowIdx >= 0 ? rawPath.slice(arrowIdx + 4).trim() : rawPath;
        return {
          status: xy,
          path: cleanPath.replace(/^"+|"+$/g, ""),
        };
      })
      .filter((item) => !isSecretCredentialFile(item.path));

    return NextResponse.json({
      isRepo: true,
      branch,
      branches,
      changes,
    });
  } catch {
    return NextResponse.json({ isRepo: false, branch: null, changes: [] });
  }
}

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

  const action = String(body.action || "");

  try {
    if (action === "init") {
      enforceWorkspaceGitignoreForSecrets(s.root);
      await runGit(s.root, ["init"]);
      s.events.push("User initialized a Git repository (`git init`).");
      persistSessionDebounced(s.id, false);
      return NextResponse.json({ ok: true });
    }

    if (action === "checkout") {
      const branch = String(body.branch || "").trim();
      if (!branch || !/^[A-Za-z0-9._/-]+$/.test(branch)) {
        return NextResponse.json(
          { error: "Invalid branch name." },
          { status: 400 }
        );
      }
      if (body.create) {
        await runGit(s.root, ["checkout", "-b", branch]);
        s.events.push(`User created and switched to Git branch \`${branch}\`.`);
      } else {
        await runGit(s.root, ["checkout", branch]);
        s.events.push(`User switched to Git branch \`${branch}\`.`);
      }
      persistSessionDebounced(s.id, false);
      return NextResponse.json({ ok: true, branch });
    }

    if (action === "commit") {
      const message = String(body.message || "").trim();
      if (!message) {
        return NextResponse.json(
          { error: "Commit message is required." },
          { status: 400 }
        );
      }

      // 1. Ensure .gitignore protects vertex_credentials.json and .env* before staging
      enforceWorkspaceGitignoreForSecrets(s.root);
      await runGit(s.root, ["add", "-A"]);
      // 2. Explicitly unstage any secret files so they can NEVER be committed or pushed
      await unstageProtectedSecrets(s.root);

      let out = "";
      try {
        out = await runGit(s.root, ["commit", "-m", message]);
      } catch (commitErr: unknown) {
        const errMsg =
          commitErr instanceof Error ? commitErr.message : String(commitErr);
        if (/Author identity unknown|user\.email|user\.name/i.test(errMsg)) {
          out = await runGit(s.root, [
            "-c",
            "user.name=Zero-Trust Studio",
            "-c",
            "user.email=studio@localhost",
            "commit",
            "-m",
            message,
          ]);
        } else {
          throw commitErr;
        }
      }

      s.logs = (s.logs + `\n$ git commit -m "${message}"\n${out}\n`).slice(
        -60_000
      );
      s.events.push(`User committed workspace changes: "${message}".`);
      persistSessionDebounced(s.id, false);
      return NextResponse.json({ ok: true, output: out });
    }

    if (action === "diff-summary") {
      enforceWorkspaceGitignoreForSecrets(s.root);
      await unstageProtectedSecrets(s.root);
      const rawStatus = await runGit(s.root, ["status", "--short"]);
      const statusOut = rawStatus
        .split(/\r?\n/)
        .filter((line) => {
          const p = line.slice(3).trim().replace(/^"+|"+$/g, "");
          return p ? !isSecretCredentialFile(p) : false;
        })
        .join("\n");

      const excludeArgs = [
        "--",
        ".",
        ...GIT_UNSTAGE_SECRETS.map((f) => `:(exclude)${f}`),
      ];
      let diffStat = "";
      try {
        diffStat = await runGit(s.root, ["diff", "HEAD", "--stat", ...excludeArgs]);
      } catch {
        diffStat = await runGit(s.root, ["diff", "--stat", ...excludeArgs]);
      }
      let diffPatch = "";
      try {
        diffPatch = (
          await runGit(s.root, ["diff", "HEAD", ...excludeArgs])
        ).slice(0, 6000);
      } catch {
        diffPatch = (await runGit(s.root, ["diff", ...excludeArgs])).slice(
          0,
          6000
        );
      }
      return NextResponse.json({
        ok: true,
        status: statusOut,
        stat: diffStat,
        patch: diffPatch,
      });
    }

    return NextResponse.json({ error: "Invalid git action." }, { status: 400 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}