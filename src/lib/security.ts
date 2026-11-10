import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  isSecretCredentialFile,
  MAX_CMD_CHARS,
  PROTECTED_FILES,
  PROTECTED_SEGMENTS,
} from "./config";
import type { BuilderSession } from "@/types/builder";

export const SYSTEM_DIR_RE =
  /^(\/(etc|usr|bin|sbin|boot|dev|proc|sys|lib|lib64|var|root)(\/|$)|[a-zA-Z]:\\(Windows|Program Files|Program Files \(x86\)|ProgramData)(\\|$))/i;

export const HIDDEN_CHARS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// Strip both CSI ANSI sequences and OSC-8 terminal hyperlink wrappers
export const ANSI_RE =
  /\x1B\[[0-9;?]*[a-zA-Z]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;

export const LONG_RUNNING_RE =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview|watch)\b|\bnext\s+(dev|start)\b|(^|[;&|]\s*|\bnpx\s+)vite(\s+(dev|preview|serve))?\s*($|--|-[a-z])|\bnodemon\b|http\.server|\b(serve|http-server|live-server|uvicorn|gunicorn)\b|\b(flask|fastapi)\s+(run|dev)\b/i;

/**
 * Extracts the latest localhost / 127.0.0.1 / 0.0.0.0 preview URL from terminal output,
 * ignoring the Studio's own port (e.g. 3005) so the preview iframe never loads the Studio itself.
 */
export function extractPreviewUrl(text: string): string | null {
  const cleaned = text.replace(ANSI_RE, "");
  const studioPort = String(
    process.env.STUDIO_PORT || process.env.PORT || "3005"
  ).trim();
  const re =
    /(https?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/gi;
  let lastValid: string | null = null;

  for (const m of cleaned.matchAll(re)) {
    const protocol = m[1].toLowerCase() === "https" ? "https" : "http";
    const portNum = Number(m[2]);
    if (portNum < 80 || portNum > 65535) continue;
    if (String(portNum) === studioPort) continue;
    lastValid = `${protocol}://localhost:${portNum}`;
  }
  return lastValid;
}

export const sha1 = (t: string): string =>
  crypto.createHash("sha1").update(t).digest("hex");

const LEGACY_SELF_FILE = path.resolve(process.cwd(), "serverr.mjs");
const CREDENTIALS_FILE = path.resolve(process.cwd(), "vertex_credentials.json");
const ROOT_ENV_FILE = path.resolve(process.cwd(), ".env");
const ROOT_ENV_LOCAL_FILE = path.resolve(process.cwd(), ".env.local");

const sameFile = (a: string, b: string): boolean =>
  process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;

const RISKY_PATTERNS: Array<[RegExp, string]> = [
  [
    /\bvertex[-_]?credentials.*\.json\b/i,
    "accessing vertex_credentials.json is strictly forbidden",
  ],
  [
    /(^|[\s"'=/\\])\.env(?:\.(?!example\b|sample\b|template\b)[a-zA-Z0-9_-]+)?(?=$|[\s"':;|>&])/i,
    "accessing .env secret files via terminal commands is strictly forbidden",
  ],
  [
    /(^|[\s;&|])(printenv|env)\s*($|[|>;])/i,
    "dumping environment variables is not allowed",
  ],
  [
    /\b(nc|ncat|netcat|socat|telnet)\b|\/dev\/tcp\//i,
    "raw network tools are not allowed",
  ],
  [
    /\b(base64|certutil)\b[^|;&]*\|\s*(sh|bash|zsh|iex|powershell|pwsh)|\s-enc(odedcommand)?\b/i,
    "encoded/obfuscated execution is not allowed",
  ],
  [
    /\b(Remove-Item|ri)\b[^;&|]*-Recurse/i,
    "recursive PowerShell delete is not allowed",
  ],
  [
    /\b(crontab|schtasks|launchctl|systemctl|setx)\b|\breg\s+(add|delete)\b/i,
    "persistence / system configuration is not allowed",
  ],
  [
    /(^|[\s"'=])~([\/\\]|\s|$)|%[A-Za-z_]+%|\$HOME\b|\$\{HOME\}|\$env:/i,
    "home-directory / environment-variable paths are not allowed",
  ],
  [/\bsudo\b/i, "sudo is not allowed"],
  [/\brm\s+-\S*[rf]/i, "recursive/forced rm is not allowed"],
  [/\b(rmdir|rd)\s+\/s/i, "recursive directory removal is not allowed"],
  [/\bdel\s+\/[a-z]/i, "bulk delete is not allowed"],
  [
    /\b(mkfs|diskpart|shutdown|reboot|halt)\b|\bformat\s+[a-z]:/i,
    "system-level command is not allowed",
  ],
  [/\bdd\s+if=/i, "raw disk access is not allowed"],
  [
    /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|;&]*\|\s*(sh|bash|zsh|iex|powershell)/i,
    "piping downloads into a shell is not allowed",
  ],
  [/\b(chmod|chown)\s+-R\b/i, "recursive permission changes are not allowed"],
  [/\bgit\s+(push|remote|config)\b/i, "git push/remote/config is not allowed"],
  [
    /\b(npm|pnpm|yarn)\s+(publish|login|adduser|config|token|set)\b/i,
    "npm/pnpm/yarn publish, login or config changes are not allowed",
  ],
  [
    /(^|[\s;&|])cd\s+(\/|~|[a-zA-Z]:|\.\.)/i,
    "cd outside the workspace is not allowed",
  ],
  [/\.\.[\\/]/, "parent-directory references are not allowed"],
  [
    /(^|[\s"'=])(\/(etc|usr|bin|home|root|var|Users)\b|[a-zA-Z]:[\\/](Windows|Users|Program))/i,
    "absolute system paths are not allowed",
  ],
];

export function riskOf(cmd: string): string | null {
  if (cmd.length > MAX_CMD_CHARS) return "command is too long";
  if (/[\r\n]/.test(cmd)) {
    return "multiline commands are not allowed (propose one command per tag)";
  }
  if (HIDDEN_CHARS.test(cmd)) return "command contains hidden/control characters";
  for (const [re, why] of RISKY_PATTERNS) {
    if (re.test(cmd)) return why;
  }
  return null;
}

export function safeResolve(
  s: BuilderSession,
  rel: string
): { resolved: string; rel: string } {
  if (!s.root) throw new Error("SECURITY: No workspace folder is locked.");
  if (typeof rel !== "string" || !rel.trim() || rel.includes("\0")) {
    throw new Error("SECURITY: Invalid path.");
  }
  const norm = rel.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const segs = norm.split("/").filter(Boolean);
  if (segs.length === 0) {
    throw new Error("SECURITY: Invalid empty path.");
  }
  if (segs.some((x) => x === ".." || x === ".")) {
    throw new Error(
      `SECURITY BLOCKED: Path traversal ("..") is forbidden: ${rel}`
    );
  }
  if (segs.some((x) => PROTECTED_SEGMENTS.has(x))) {
    throw new Error(`SECURITY BLOCKED: Protected folder: ${rel}`);
  }
  if (
    segs.some(
      (x) => WIN_RESERVED_RE.test(x) || x.endsWith(".") || x.endsWith(" ")
    )
  ) {
    throw new Error(
      `SECURITY BLOCKED: Reserved device name or invalid trailing character in path: ${rel}`
    );
  }
  if (HIDDEN_CHARS.test(norm) || norm.includes(":") || norm.length > 300) {
    throw new Error(
      `SECURITY BLOCKED: Invalid characters or length in path: ${JSON.stringify(rel.slice(0, 80))}`
    );
  }
  const base = segs[segs.length - 1].toLowerCase();
  if (isSecretCredentialFile(base)) {
    throw new Error(
      `SECURITY BLOCKED: Secret credential/environment file "${base}" can never be read or modified.`
    );
  }
  if (
    PROTECTED_FILES.has(base) ||
    (/^\.env(\..+)?$/.test(base) && !/\.(example|sample|template)$/.test(base))
  ) {
    throw new Error(`SECURITY BLOCKED: Protected config/secret file: ${rel}`);
  }

  const root = path.resolve(s.root);
  if (!fs.existsSync(root)) {
    throw new Error(
      "SECURITY: Locked workspace folder no longer exists on disk."
    );
  }
  const resolved = path.resolve(root, norm);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`SECURITY BLOCKED: "${rel}" escapes the workspace!`);
  }
  if (
    sameFile(resolved, LEGACY_SELF_FILE) ||
    sameFile(resolved, CREDENTIALS_FILE) ||
    sameFile(resolved, ROOT_ENV_FILE) ||
    sameFile(resolved, ROOT_ENV_LOCAL_FILE)
  ) {
    throw new Error(
      "SECURITY BLOCKED: Protected studio credential/env file cannot be read or modified."
    );
  }

  // Verify every existing path component via lstatSync to block broken or active symlinks
  const realRoot = fs.realpathSync(root);
  let curCheck = root;
  for (const seg of segs) {
    curCheck = path.join(curCheck, seg);
    let lst: fs.Stats | null = null;
    try {
      lst = fs.lstatSync(curCheck);
    } catch {
      lst = null;
    }
    if (lst) {
      if (lst.isSymbolicLink()) {
        throw new Error(
          `SECURITY BLOCKED: Symbolic links are not allowed inside the sandbox workspace (${rel}).`
        );
      }
      const realCur = fs.realpathSync(curCheck);
      if (realCur !== realRoot && !realCur.startsWith(realRoot + path.sep)) {
        throw new Error(
          `SECURITY BLOCKED: "${rel}" resolves outside the workspace.`
        );
      }
    }
  }

  return {
    resolved,
    rel: path.relative(root, resolved).replace(/\\/g, "/"),
  };
}

/**
 * Strips all secret keys, tokens, Google/Cloud credentials, AND the Studio's own PORT/STUDIO_PORT
 * so child dev servers (`npm run dev`) inside the Sandbox Terminal never leak secrets or collide with Port 3005.
 */
export function safeEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !/KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|AUTH|COOKIE|^(PORT|STUDIO_PORT)$|^(GOOGLE|GCP|VERTEX|CLOUDSDK|AWS|AZURE|GITHUB|GH|NPM)_/i.test(
          k
        )
    )
  ) as NodeJS.ProcessEnv;
}