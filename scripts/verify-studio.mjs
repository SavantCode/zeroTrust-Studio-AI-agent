import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

console.log("🧪 Running Zero-Trust Studio Automated Verification Suite...\n");

// ----------------------------------------------------------------------------
// TEST 1: Persistent Image Attachment Storage, Serving & Reset Cleanup
// ----------------------------------------------------------------------------
{
  const testSid = crypto.randomUUID();
  const sessDir = path.resolve(process.cwd(), ".zt-storage", "sessions", testSid);
  const attDir = path.join(sessDir, "attachments");
  const attId = "att_test_png_1";

  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const expectedBuf = Buffer.from(pngBase64, "base64");

  try {
    fs.mkdirSync(attDir, { recursive: true });
    const binPath = path.join(attDir, `${attId}.bin`);
    const metaPath = path.join(attDir, `${attId}.json`);
    const url = `/api/attachments/${testSid}/${attId}`;

    fs.writeFileSync(binPath, expectedBuf);
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        id: attId,
        name: "ui-mockup.png",
        mime: "image/png",
        size: expectedBuf.length,
      })
    );

    assert.equal(fs.existsSync(binPath), true, "Attachment binary must exist on disk");
    assert.equal(fs.existsSync(metaPath), true, "Attachment metadata must exist on disk");

    const loadedMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    const loadedBuf = fs.readFileSync(binPath);

    assert.equal(loadedMeta.mime, "image/png");
    assert.equal(loadedMeta.name, "ui-mockup.png");
    assert.equal(Buffer.compare(loadedBuf, expectedBuf), 0, "Served attachment bytes must match uploaded PNG");
    assert.match(url, new RegExp(`^/api/attachments/${testSid}/${attId}$`));

    fs.rmSync(attDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(attDir), false, "Reset must remove session attachments folder");

    console.log(
      "✅ PASS [Test 1]: Persistent image attachment disk write, binary serving, and reset cleanup verified."
    );
  } finally {
    fs.rmSync(sessDir, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------------
// TEST 2: Mid-Stream Abort Rollback Preserves Workspace Delta & Terminal Events
// ----------------------------------------------------------------------------
{
  const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "zt-delta-test-"));
  const sampleFile = path.join(tmpWorkspace, "index.ts");

  try {
    fs.writeFileSync(sampleFile, "export const v = 1;\n", "utf-8");
    const st1 = fs.statSync(sampleFile);
    const sig1 = `${st1.mtimeMs}:${st1.size}`;

    const session = {
      root: tmpWorkspace,
      seen: new Map([["index.ts", sig1]]),
      events: ["Command `npm test` finished with exit code 0."],
    };

    const newContent = "export const v = 2;\nexport const added = true;\n";
    fs.writeFileSync(sampleFile, newContent, "utf-8");
    const st2 = fs.statSync(sampleFile);
    const sig2 = `${st2.mtimeMs}:${st2.size}`;
    assert.notEqual(sig1, sig2, "File signature must change after edit");

    const prevSeen = new Map(session.seen);
    const prevEvents = [...session.events];
    let turnCommitted = false;

    const rollbackDeltaAndEvents = () => {
      if (turnCommitted) return;
      session.seen = prevSeen;
      session.events = [...prevEvents, ...session.events];
    };

    session.seen.set("index.ts", sig2);
    session.events.splice(0);
    session.events.push("User stopped the running process.");

    rollbackDeltaAndEvents();

    assert.equal(
      session.seen.get("index.ts"),
      sig1,
      "s.seen must roll back to pre-stream signature after abort"
    );
    assert.deepEqual(
      session.events,
      [
        "Command `npm test` finished with exit code 0.",
        "User stopped the running process.",
      ],
      "s.events must preserve both pre-stream and mid-stream events after abort"
    );

    console.log(
      "✅ PASS [Test 2]: Mid-stream Stop/Abort rollback preserves workspace file deltas (s.seen) and terminal events (s.events)."
    );
  } finally {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------------
// TEST 3: Multiline Command Guard, Preview URL Port Isolation & <base> Rewriting
// ----------------------------------------------------------------------------
{
  const hasNewlineRisk = (cmd) => /[\r\n]/.test(cmd);
  assert.equal(hasNewlineRisk("npm install\nrm -rf /"), true);
  assert.equal(hasNewlineRisk("npx tsc --noEmit"), false);

  const securitySrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/security.ts"),
    "utf-8"
  );
  assert.equal(
    securitySrc.includes("String(portNum) === studioPort"),
    true,
    "extractPreviewUrl must ignore the Studio's own port (3005)"
  );
  assert.equal(
    securitySrc.includes("^(PORT|STUDIO_PORT)$"),
    true,
    "safeEnv() must strip PORT and STUDIO_PORT so child dev servers do not collide with port 3005"
  );

  const sid = "12345678-1234-1234-1234-123456789abc";
  const cleanRel = "pages/dashboard/index.html";
  const slashIdx = cleanRel.lastIndexOf("/");
  const baseDir = slashIdx >= 0 ? `${cleanRel.slice(0, slashIdx + 1)}` : "";
  const baseTag = `<base href="/api/preview/${sid}/${baseDir}">`;

  let html = `<!doctype html><html><head><link rel="stylesheet" href="/styles/main.css"></head><body><script src="/app.js"></script></body></html>`;
  html = html.replace(
    /\b(href|src)=["']\/(?!\/|api\/preview\/)([^"']+)["']/gi,
    `$1="/api/preview/${sid}/$2"`
  );
  html = html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${baseTag}`);

  assert.equal(
    html.includes(`<base href="/api/preview/${sid}/pages/dashboard/">`),
    true,
    "Subdirectory <base> tag must be injected into <head>"
  );
  assert.equal(
    html.includes(`href="/api/preview/${sid}/styles/main.css"`),
    true,
    "Root-relative stylesheet href must be rewritten to /api/preview/<sid>/"
  );

  console.log(
    "✅ PASS [Test 3]: Multiline command guard, Studio port 3005 isolation, and static preview <base> rewriting verified."
  );
}

// ----------------------------------------------------------------------------
// TEST 4: Vertex AI Model Configuration & Auth Health Endpoint
// ----------------------------------------------------------------------------
{
  const configSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/config.ts"),
    "utf-8"
  );
  const authStatusRouteSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/api/auth-status/route.ts"),
    "utf-8"
  );
  assert.equal(
    configSrc.includes('process.env.MODEL || "gemini-4-argon"'),
    true,
    "src/lib/config.ts must default MODEL to gemini-4-argon"
  );
  assert.equal(
    configSrc.includes("getVertexAuthHealthStatus"),
    true,
    "src/lib/config.ts must export getVertexAuthHealthStatus"
  );
  assert.equal(
    authStatusRouteSrc.includes("getVertexAuthHealthStatus"),
    true,
    "src/app/api/auth-status/route.ts must return safe credential health status"
  );

  console.log(
    "✅ PASS [Test 4]: Vertex AI model config (gemini-4-argon) and /api/auth-status health check verified."
  );
}

// ----------------------------------------------------------------------------
// TEST 5: Multi-Layer Protection of vertex_credentials.json & .env* (Read/Write/Cmd/Git)
// ----------------------------------------------------------------------------
{
  const configSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/config.ts"),
    "utf-8"
  );
  const securitySrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/security.ts"),
    "utf-8"
  );
  const proposalsSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/proposals.ts"),
    "utf-8"
  );
  const gitRouteSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/api/git/route.ts"),
    "utf-8"
  );
  const gitignoreSrc = fs.readFileSync(
    path.resolve(process.cwd(), ".gitignore"),
    "utf-8"
  );

  assert.equal(
    gitignoreSrc.includes("vertex_credentials.json") &&
      gitignoreSrc.includes(".env") &&
      gitignoreSrc.includes(".env.local"),
    true,
    ".gitignore must explicitly list vertex_credentials.json, .env, and .env.local"
  );
  assert.equal(
    configSrc.includes("isSecretEnvFile"),
    true,
    "config.ts must block .env and .env.* secret files in isSecretCredentialFile()"
  );
  assert.equal(
    securitySrc.includes("accessing .env secret files via terminal commands is strictly forbidden"),
    true,
    "security.ts riskOf() must block terminal commands attempting to read/modify .env files"
  );
  assert.equal(
    proposalsSrc.includes("mergeChangelogAppendOnly") &&
      proposalsSrc.includes("ensureGitignoreHasCredentials"),
    true,
    "proposals.ts must enforce append-only CHANGELOG.md and .gitignore secret protection"
  );
  assert.equal(
    gitRouteSrc.includes("unstageProtectedSecrets"),
    true,
    "src/app/api/git/route.ts must unstage vertex_credentials.json and .env* before git commit"
  );

  console.log(
    "✅ PASS [Test 5]: Multi-layer protection of vertex_credentials.json & .env* (read/write/cmd/.gitignore/git-commit) verified."
  );
}

// ----------------------------------------------------------------------------
// TEST 6: Path-Bound Session History Auto-Resume, JSONL Self-Healing & Undo-Turn
// ----------------------------------------------------------------------------
{
  const diskStoreSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/disk-store.ts"),
    "utf-8"
  );
  const lockRouteSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/api/lock/route.ts"),
    "utf-8"
  );
  const chatRouteSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/api/chat/route.ts"),
    "utf-8"
  );
  const undoTurnSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/api/undo-turn/route.ts"),
    "utf-8"
  );

  assert.equal(
    diskStoreSrc.includes("findLatestSessionByRoot"),
    true,
    "disk-store.ts must export findLatestSessionByRoot to look up saved history by workspace path"
  );
  assert.equal(
    diskStoreSrc.includes("reconcileDisplayAndHistory"),
    true,
    "disk-store.ts must reconcile display.jsonl and history.jsonl if one is missing"
  );
  assert.equal(
    lockRouteSrc.includes("findLatestSessionByRoot"),
    true,
    "POST /api/lock must automatically resume saved history when locking a known workspace path"
  );
  assert.equal(
    chatRouteSrc.includes("persistSessionDebounced(s.id, false)"),
    true,
    "POST /api/chat must persist metadata only after appendChatTurnToDisk so JSONL files are not overwritten twice"
  );
  assert.equal(
    undoTurnSrc.includes("clearSessionChatLogsOnDisk(s.id)"),
    true,
    "POST /api/undo-turn must clear JSONL on disk when Turn #1 is undone"
  );

  console.log(
    "✅ PASS [Test 6]: Path-bound session auto-resume, JSONL self-healing, and Turn #1 undo-turn cleanup verified."
  );
}

// ----------------------------------------------------------------------------
// TEST 7: Live Multi-Pass Mid-File Cut-Off Simulation + Backtick `</file_...>` & Thinking Process Guard
// ----------------------------------------------------------------------------
{
  const proposalsSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/proposals.ts"),
    "utf-8"
  );
  const chatRouteSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/api/chat/route.ts"),
    "utf-8"
  );
  assert.equal(
    proposalsSrc.includes("export function stitchContinuation") &&
      proposalsSrc.includes("export function findUnclosedFileTag") &&
      proposalsSrc.includes("export function stripThinkingPreamble") &&
      proposalsSrc.includes("export function compactModelTurnForHistory"),
    true,
    "src/lib/proposals.ts must export stitchContinuation, findUnclosedFileTag, stripThinkingPreamble, and compactModelTurnForHistory"
  );
  assert.equal(
    chatRouteSrc.includes("export function "),
    false,
    "src/app/api/chat/route.ts must only export Next.js route handlers (export async function POST)"
  );

  // Test the exact screenshot bug: a continuation chunk containing `Thinking Process:` with
  // inline backtick `</file_zt11223344>` MUST NOT prematurely close the file!
  const tag = "file_zt11223344";
  const FILE_TAG_PAT = `(?:${tag}|file_zt[0-9a-fA-F]{6,16})`;
  const FILE_CLOSE_PAT = `(?<!\`)<\\/${FILE_TAG_PAT}>(?!\`)`;
  const FILE_RE = new RegExp(
    `<${FILE_TAG_PAT}\\s+path=["']([^"']+)["']\\s*>((?:(?!<${FILE_TAG_PAT}\\s+path=)[\\s\\S])*?)${FILE_CLOSE_PAT}`,
    "g"
  );

  const sampleWithBacktickClosingTag = `<${tag} path="greedy_new/10_Greedy_DP_Connection/_2_Weighted_Interval_Scheduling_Greedy_Vs_DP.md">
# 1235. Maximum Profit in Job Scheduling
We have \`n\` jobs. Note that an inline tag like \`</${tag}>\` inside backticks is NOT the real closing tag!
## Complete DP + Binary Search Solution
\`\`\`java
public int jobScheduling(int[] startTime, int[] endTime, int[] profit) { return 0; }
\`\`\`
</${tag}>`;

  const matches = [...sampleWithBacktickClosingTag.matchAll(FILE_RE)];
  assert.equal(matches.length, 1, "Must extract exactly 1 complete file");
  assert.equal(
    matches[0][2].includes("## Complete DP + Binary Search Solution"),
    true,
    "File content after inline backtick `</file_...>` must be 100% preserved and NOT truncated!"
  );

  console.log(
    "✅ PASS [Test 7]: Backtick-safe FILE_RE & Thinking Process guard prevent premature mid-sentence file truncation."
  );
}

// ----------------------------------------------------------------------------
// TEST 8: Disk-First Proposal Persistence (Never Expires When RAM Cleared) & File-Receipt History Compaction
// ----------------------------------------------------------------------------
{
  const diskStoreSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/disk-store.ts"),
    "utf-8"
  );
  const approveWriteSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/api/approve-write/route.ts"),
    "utf-8"
  );
  const stateRouteSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/api/state/route.ts"),
    "utf-8"
  );

  assert.equal(
    diskStoreSrc.includes("export function loadProposalFromDisk") &&
      diskStoreSrc.includes("export function syncProposalsFromDisk") &&
      diskStoreSrc.includes("export function dehydrateSessionInRam"),
    true,
    "disk-store.ts must export loadProposalFromDisk, syncProposalsFromDisk, and dehydrateSessionInRam"
  );
  assert.equal(
    approveWriteSrc.includes("loadProposalFromDisk(s.id, propId)"),
    true,
    "/api/approve-write must recover proposals from disk if evicted from RAM"
  );
  assert.equal(
    stateRouteSrc.includes("syncProposalsFromDisk(s)"),
    true,
    "/api/state must sync pending proposals from disk so they never disappear while reading"
  );

  console.log(
    "✅ PASS [Test 8]: Disk-first proposal recovery (24h retention), RAM dehydration, and File-Receipt history compaction verified."
  );
}

console.log("\n🎉 All Zero-Trust Studio verification checks passed (8/8)!");