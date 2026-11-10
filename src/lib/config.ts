import fs from "fs";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";

// Ensure .env / .env.local are loaded in all server contexts
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

export const PROJECT =
  process.env.GCP_PROJECT ||
  process.env.GOOGLE_PROJECT_ID ||
  "heyo-478009";
export const LOCATION = process.env.GCP_LOCATION || "global";
export const MODEL = process.env.MODEL || "gemini-4-argon";

export interface VertexServiceAccountCredentials {
  type: string;
  project_id: string;
  private_key_id?: string;
  private_key: string;
  client_email: string;
  client_id?: string;
  auth_uri?: string;
  token_uri?: string;
  auth_provider_x509_cert_url?: string;
  client_x509_cert_url?: string;
  universe_domain?: string;
}

export interface VertexAuthHealthStatus {
  configured: boolean;
  source: "env-vars" | "env-json" | "key-file" | "missing";
  sourceLabel: string;
  project: string;
  location: string;
  model: string;
  maskedClientEmail: string | null;
  validPemKey: boolean;
  pemError?: string | null;
  hint: string;
}

function stripSurroundingQuotes(val: string): string {
  let t = val.trim();
  // Remove trailing comma or semicolon often copied from JSON lines (e.g. "value",)
  t = t.replace(/[,;]+$/, "").trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith("`") && t.endsWith("`"))
  ) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/**
 * Repairs common `.env` copy-paste corruptions in PEM private keys (trailing commas,
 * surrounding/escaped quotes, double-escaped `\\n`, single-line spaces instead of newlines,
 * or missing PEM headers) and verifies both PKCS#8 export AND real `RSA-SHA256` JWT signing
 * via Node's OpenSSL 3 `crypto` module so `error:1E08010C:DECODER routines::unsupported` never occurs.
 */
export function validateAndCanonicalizePrivateKey(rawKey: string): {
  valid: boolean;
  pem: string;
  error: string | null;
} {
  if (!rawKey || !rawKey.trim()) {
    return { valid: false, pem: "", error: "Private key is empty." };
  }

  // 1. Strip surrounding quotes, trailing JSON commas, and normalize escaped newlines
  let cleaned = stripSurroundingQuotes(rawKey)
    .replace(/^["'`]+|["'`,;\s]+$/g, "")
    .replace(/\\+r?\\+n/g, "\n")
    .replace(/\r\n?/g, "\n")
    .replace(/\\(["'])/g, "$1")
    .trim();

  if (!cleaned) {
    return { valid: false, pem: "", error: "Private key is empty after cleanup." };
  }

  // Helper to test OpenSSL key decode, export canonical PKCS#8 PEM, AND verify RSA-SHA256 signing
  // (the exact operation google-auth-library performs when minting Vertex AI OAuth2 tokens)
  const tryParseAndSignPem = (candidate: string): string | null => {
    try {
      const keyObj = crypto.createPrivateKey({
        key: candidate,
        format: "pem",
      });
      const canonicalPem = keyObj
        .export({ type: "pkcs8", format: "pem" })
        .toString();
      const testSig = crypto.sign(
        "RSA-SHA256",
        Buffer.from("vertex-jwt-self-test"),
        keyObj
      );
      if (!testSig || testSig.length === 0) return null;
      return canonicalPem;
    } catch {
      return null;
    }
  };

  // Fast path: already valid & signable PEM
  const direct = tryParseAndSignPem(cleaned);
  if (direct) {
    return { valid: true, pem: direct, error: null };
  }

  // 2. Extract header type and base64 payload to rebuild a clean 64-char-per-line PEM
  const headerMatch = cleaned.match(
    /-----BEGIN\s+([A-Z0-9\s]*?PRIVATE KEY)\s*-----([\s\S]*?)(?:-----END\s+[A-Z0-9\s]*?PRIVATE KEY\s*-----|$)/i
  );

  const keyType = headerMatch
    ? headerMatch[1].trim().toUpperCase()
    : "PRIVATE KEY";
  let rawBody = headerMatch ? headerMatch[2] : cleaned;

  // Strip any accidental literal "\n" remnants or non-base64 characters
  rawBody = rawBody.replace(/\\n/g, "").replace(/[^A-Za-z0-9+/=]/g, "");

  if (rawBody.length < 128) {
    return {
      valid: false,
      pem: cleaned,
      error:
        "Private key base64 body is too short or truncated. Copy the full private_key from your Service Account JSON.",
    };
  }

  const buildReconstructed = (bodyStr: string, typeLabel: string): string => {
    const lines = bodyStr.match(/.{1,64}/g) || [];
    return `-----BEGIN ${typeLabel}-----\n${lines.join("\n")}\n-----END ${typeLabel}-----\n`;
  };

  const candidates: string[] = [
    buildReconstructed(rawBody, keyType),
    ...(keyType !== "PRIVATE KEY"
      ? [buildReconstructed(rawBody, "PRIVATE KEY")]
      : []),
    ...(keyType !== "RSA PRIVATE KEY"
      ? [buildReconstructed(rawBody, "RSA PRIVATE KEY")]
      : []),
  ];

  // Also try base64 padding repair if length is not a multiple of 4
  const rem = rawBody.length % 4;
  if (rem > 0) {
    const padded = rawBody + "=".repeat(4 - rem);
    candidates.push(buildReconstructed(padded, keyType));
  }

  let lastErr = "OpenSSL failed to decode GOOGLE_PRIVATE_KEY.";
  for (const cand of candidates) {
    try {
      const keyObj = crypto.createPrivateKey({
        key: cand,
        format: "pem",
      });
      const canonical = keyObj
        .export({ type: "pkcs8", format: "pem" })
        .toString();
      crypto.sign("RSA-SHA256", Buffer.from("vertex-jwt-self-test"), keyObj);
      return { valid: true, pem: canonical, error: null };
    } catch (e: unknown) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    valid: false,
    pem: candidates[0] || cleaned,
    error: lastErr,
  };
}

function normalizePrivateKey(rawKey: string): string {
  const res = validateAndCanonicalizePrivateKey(rawKey);
  return res.pem;
}

function maskEmail(email: string): string {
  const trimmed = email.trim();
  const atIdx = trimmed.indexOf("@");
  if (atIdx <= 2) return trimmed;
  const user = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx);
  const visible = user.slice(0, Math.min(4, user.length));
  return `${visible}•••${domain}`;
}

function isPlaceholderValue(val: string): boolean {
  return /YOUR_PRIVATE_KEY_CONTENT_HERE|your-service-account@|your_private_key_id_here/i.test(
    val
  );
}

export function reloadDotEnvFiles(): void {
  dotenv.config({
    path: path.resolve(process.cwd(), ".env.local"),
    override: true,
  });
  dotenv.config({
    path: path.resolve(process.cwd(), ".env"),
    override: true,
  });
}

/**
 * Resolves Vertex AI credentials in priority order:
 * 1. Individual `.env` variables (`GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY` + `GOOGLE_PROJECT_ID`, etc.)
 * 2. Single-line `.env` JSON (`GOOGLE_SERVICE_ACCOUNT_JSON` or `VERTEX_CREDENTIALS_JSON`)
 * 3. `GOOGLE_APPLICATION_CREDENTIALS` or `vertex_credentials.json` in Studio root, parent dir, or locked workspace
 *
 * Automatically validates each candidate's `private_key` with OpenSSL (`crypto.createPrivateKey` + `crypto.sign`).
 * If `.env` has a malformed key, it will fall back to a valid JSON key file if one exists.
 */
export function resolveVertexAuthOptions(workspaceRoot?: string | null): {
  project: string;
  location: string;
  source: "env-vars" | "env-json" | "key-file" | "missing";
  sourceLabel: string;
  validPemKey: boolean;
  pemError: string | null;
  googleAuthOptions?: {
    credentials?: VertexServiceAccountCredentials;
    keyFilename?: string;
    projectId?: string;
  };
} {
  // Reload .env on demand if variables were added or updated from placeholders after server start
  if (
    (!process.env.GOOGLE_PRIVATE_KEY &&
      !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) ||
    isPlaceholderValue(process.env.GOOGLE_PRIVATE_KEY || "") ||
    isPlaceholderValue(process.env.GOOGLE_CLIENT_EMAIL || "")
  ) {
    reloadDotEnvFiles();
  }

  const envClientEmail = stripSurroundingQuotes(
    process.env.GOOGLE_CLIENT_EMAIL || process.env.VERTEX_CLIENT_EMAIL || ""
  );
  const envPrivateKey =
    process.env.GOOGLE_PRIVATE_KEY || process.env.VERTEX_PRIVATE_KEY || "";
  const envProjectId = stripSurroundingQuotes(
    process.env.GOOGLE_PROJECT_ID || process.env.GCP_PROJECT || PROJECT
  );
  const envLocation = stripSurroundingQuotes(
    process.env.GCP_LOCATION || LOCATION
  );

  let fallbackInvalidResult: {
    project: string;
    location: string;
    source: "env-vars" | "env-json" | "key-file" | "missing";
    sourceLabel: string;
    validPemKey: boolean;
    pemError: string | null;
    googleAuthOptions?: {
      credentials?: VertexServiceAccountCredentials;
      projectId?: string;
    };
  } | null = null;

  // 1. Direct .env fields (matching the 11 fields from Service Account JSON)
  if (
    envClientEmail &&
    envPrivateKey &&
    !isPlaceholderValue(envClientEmail) &&
    !isPlaceholderValue(envPrivateKey)
  ) {
    const keyValidation = validateAndCanonicalizePrivateKey(envPrivateKey);
    const credentials: VertexServiceAccountCredentials = {
      type:
        stripSurroundingQuotes(process.env.GOOGLE_TYPE || "") ||
        "service_account",
      project_id: envProjectId,
      private_key_id:
        stripSurroundingQuotes(process.env.GOOGLE_PRIVATE_KEY_ID || "") ||
        undefined,
      private_key: keyValidation.pem,
      client_email: envClientEmail,
      client_id:
        stripSurroundingQuotes(process.env.GOOGLE_CLIENT_ID || "") || undefined,
      auth_uri:
        stripSurroundingQuotes(process.env.GOOGLE_AUTH_URI || "") ||
        "https://accounts.google.com/o/oauth2/auth",
      token_uri:
        stripSurroundingQuotes(process.env.GOOGLE_TOKEN_URI || "") ||
        "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url:
        stripSurroundingQuotes(
          process.env.GOOGLE_AUTH_PROVIDER_X509_CERT_URL || ""
        ) || "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url:
        stripSurroundingQuotes(
          process.env.GOOGLE_CLIENT_X509_CERT_URL || ""
        ) || undefined,
      universe_domain:
        stripSurroundingQuotes(process.env.GOOGLE_UNIVERSE_DOMAIN || "") ||
        "googleapis.com",
    };

    if (keyValidation.valid) {
      return {
        project: envProjectId,
        location: envLocation,
        source: "env-vars",
        sourceLabel: ".env (GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY)",
        validPemKey: true,
        pemError: null,
        googleAuthOptions: {
          credentials,
          projectId: envProjectId,
        },
      };
    } else {
      fallbackInvalidResult = {
        project: envProjectId,
        location: envLocation,
        source: "env-vars",
        sourceLabel: ".env (GOOGLE_PRIVATE_KEY has invalid PEM format)",
        validPemKey: false,
        pemError: keyValidation.error,
        googleAuthOptions: {
          credentials,
          projectId: envProjectId,
        },
      };
    }
  }

  // 2. Single-line JSON in .env (GOOGLE_SERVICE_ACCOUNT_JSON)
  const rawJsonEnv =
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    process.env.VERTEX_CREDENTIALS_JSON;
  if (rawJsonEnv && rawJsonEnv.trim() && !isPlaceholderValue(rawJsonEnv)) {
    try {
      const parsed = JSON.parse(
        stripSurroundingQuotes(rawJsonEnv)
      ) as VertexServiceAccountCredentials;
      if (parsed.private_key) {
        const keyValidation = validateAndCanonicalizePrivateKey(
          parsed.private_key
        );
        parsed.private_key = keyValidation.pem;
        const proj = parsed.project_id || envProjectId;
        if (keyValidation.valid) {
          return {
            project: proj,
            location: envLocation,
            source: "env-json",
            sourceLabel: ".env (GOOGLE_SERVICE_ACCOUNT_JSON)",
            validPemKey: true,
            pemError: null,
            googleAuthOptions: {
              credentials: parsed,
              projectId: proj,
            },
          };
        } else if (!fallbackInvalidResult) {
          fallbackInvalidResult = {
            project: proj,
            location: envLocation,
            source: "env-json",
            sourceLabel: ".env (GOOGLE_SERVICE_ACCOUNT_JSON invalid PEM)",
            validPemKey: false,
            pemError: keyValidation.error,
            googleAuthOptions: {
              credentials: parsed,
              projectId: proj,
            },
          };
        }
      }
    } catch {
      // fall through to file check
    }
  }

  // 3. Check JSON file paths (GOOGLE_APPLICATION_CREDENTIALS, cwd, parent, or workspaceRoot)
  const candidateFiles: Array<{ full: string; label: string }> = [];
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    candidateFiles.push({
      full: path.resolve(
        process.cwd(),
        stripSurroundingQuotes(process.env.GOOGLE_APPLICATION_CREDENTIALS)
      ),
      label: "GOOGLE_APPLICATION_CREDENTIALS file",
    });
  }
  candidateFiles.push({
    full: path.resolve(process.cwd(), "vertex_credentials.json"),
    label: "./vertex_credentials.json (Studio Root)",
  });
  candidateFiles.push({
    full: path.resolve(process.cwd(), "..", "vertex_credentials.json"),
    label: "../vertex_credentials.json (Parent Folder)",
  });
  if (workspaceRoot) {
    candidateFiles.push({
      full: path.resolve(workspaceRoot, "vertex_credentials.json"),
      label: "Workspace vertex_credentials.json",
    });
  }

  for (const fileCandidate of candidateFiles) {
    try {
      if (
        fs.existsSync(fileCandidate.full) &&
        fs.statSync(fileCandidate.full).isFile()
      ) {
        const parsed = JSON.parse(
          fs.readFileSync(fileCandidate.full, "utf-8")
        ) as VertexServiceAccountCredentials;
        if (parsed.client_email && parsed.private_key) {
          const keyValidation = validateAndCanonicalizePrivateKey(
            parsed.private_key
          );
          parsed.private_key = keyValidation.pem;
          const proj =
            stripSurroundingQuotes(
              process.env.GCP_PROJECT || process.env.GOOGLE_PROJECT_ID || ""
            ) ||
            parsed.project_id ||
            PROJECT;
          if (keyValidation.valid) {
            return {
              project: proj,
              location: envLocation,
              source: "key-file",
              sourceLabel: fileCandidate.label,
              validPemKey: true,
              pemError: null,
              googleAuthOptions: {
                credentials: parsed,
                projectId: proj,
              },
            };
          } else if (!fallbackInvalidResult) {
            fallbackInvalidResult = {
              project: proj,
              location: envLocation,
              source: "key-file",
              sourceLabel: `${fileCandidate.label} (invalid PEM)`,
              validPemKey: false,
              pemError: keyValidation.error,
              googleAuthOptions: {
                credentials: parsed,
                projectId: proj,
              },
            };
          }
        }
      }
    } catch {
      // try next candidate
    }
  }

  if (fallbackInvalidResult) {
    return fallbackInvalidResult;
  }

  // Fallback to missing / default ADC
  return {
    project: envProjectId,
    location: envLocation,
    source: "missing",
    sourceLabel: "No .env or vertex_credentials.json found",
    validPemKey: false,
    pemError: null,
  };
}

/**
 * Returns non-sensitive diagnostic metadata about Vertex AI credential readiness
 * for the HeaderBar health check badge. Uses real OpenSSL PEM + RSA-SHA256 verification and never exposes private keys.
 */
export function getVertexAuthHealthStatus(
  workspaceRoot?: string | null,
  forceReloadEnv = false
): VertexAuthHealthStatus {
  if (forceReloadEnv) {
    reloadDotEnvFiles();
  }
  const resolved = resolveVertexAuthOptions(workspaceRoot);
  const creds = resolved.googleAuthOptions?.credentials;
  const validPemKey = resolved.validPemKey;
  const configured = Boolean(
    resolved.source !== "missing" && creds?.client_email && validPemKey
  );

  let hint =
    "Vertex AI Service Account credentials loaded and RSA-SHA256 signature verified.";
  if (!configured) {
    if (resolved.pemError) {
      hint = `GOOGLE_PRIVATE_KEY failed OpenSSL PEM decoding (${resolved.pemError}). Ensure the full key between "-----BEGIN PRIVATE KEY-----" and "-----END PRIVATE KEY-----" is copied from your Service Account JSON into .env on a single double-quoted line with \\n line breaks.`;
    } else {
      hint =
        "Copy .env.example to .env and add GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, and GOOGLE_PROJECT_ID.";
    }
  }

  return {
    configured,
    source: resolved.source,
    sourceLabel: resolved.sourceLabel,
    project: resolved.project,
    location: resolved.location,
    model: stripSurroundingQuotes(process.env.MODEL || MODEL),
    maskedClientEmail: creds?.client_email
      ? maskEmail(creds.client_email)
      : null,
    validPemKey,
    pemError: resolved.pemError,
    hint,
  };
}

export { normalizePrivateKey };

export const TOTAL_CHAR_BUDGET =
  Number(process.env.CONTEXT_CHAR_BUDGET) || 800_000;
export const SNAPSHOT_CHAR_BUDGET = 400_000;
export const DELTA_CHAR_BUDGET = 150_000;
export const MAX_FILE_BYTES = 100_000;
export const MAX_OUTPUT_TOKENS =
  Number(process.env.MAX_OUTPUT_TOKENS) || 65_536;

// 24-Hour Session Memory TTL (auto-deletes after 24 hours)
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = SESSION_TTL_MS;
export const TAB_CLOSE_GRACE_MS = SESSION_TTL_MS;

export const MAX_SESSIONS = 50;
export const MAX_PROMPT_CHARS = 60_000;
export const MAX_PROPOSAL_BYTES = 2_000_000;
export const MAX_PROPOSALS = 60;
export const MAX_COMMANDS = 20;
export const MAX_CMD_CHARS = 2000;

export const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  "out",
  ".vercel",
  ".zt-storage",
  ".zt-session-store",
]);

export const LOCKFILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
]);

export const ALLOWED_EXT = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".json",
  ".jsonc",
  ".md",
  ".mdx",
  ".py",
  ".vue",
  ".svelte",
  ".astro",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".txt",
  ".csv",
  ".tsv",
  ".xml",
  ".svg",
  ".sql",
  ".prisma",
  ".graphql",
  ".gql",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".cmd",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".php",
  ".rb",
  ".swift",
  ".dart",
  ".lua",
  ".r",
  ".dockerfile",
  ".example",
  ".sample",
  ".template",
]);

export const ALLOWED_FILENAMES = new Set([
  "dockerfile",
  "makefile",
  "procfile",
  "caddyfile",
  "gemfile",
  "rakefile",
  ".gitignore",
  ".dockerignore",
  ".eslintignore",
  ".prettierignore",
  ".prettierrc",
  ".eslintrc",
  ".babelrc",
  ".editorconfig",
  ".nvmrc",
  ".node-version",
  "license",
  "licence",
  "readme",
  "changelog",
]);

export const PROTECTED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".zt-storage",
  ".zt-session-store",
]);
export const PROTECTED_FILES = new Set([
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".gitmodules",
  ".pnpmfile.cjs",
  "vertex_credentials.json",
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  "serverr.mjs",
]);

export const isSecretEnvFile = (nameOrRelPath: string): boolean => {
  const base = path.basename(nameOrRelPath).toLowerCase();
  if (!base.startsWith(".env")) return false;
  return !/\.(example|sample|template)$/i.test(base);
};

export const isSecretCredentialFile = (nameOrRelPath: string): boolean => {
  const base = path.basename(nameOrRelPath).toLowerCase();
  return (
    base === "vertex_credentials.json" ||
    /^vertex[-_]?credentials.*\.json$/i.test(base) ||
    isSecretEnvFile(base)
  );
};

export const isReadable = (name: string): boolean => {
  const lower = path.basename(name).toLowerCase();
  if (
    isSecretCredentialFile(lower) ||
    LOCKFILES.has(lower) ||
    PROTECTED_FILES.has(lower)
  ) {
    return false;
  }
  if (lower.startsWith(".env")) {
    return /\.(example|sample|template)$/i.test(lower);
  }
  if (ALLOWED_FILENAMES.has(lower)) return true;
  if (lower.startsWith("dockerfile.") || lower.startsWith("docker-compose.")) {
    return true;
  }
  return ALLOWED_EXT.has(path.extname(lower));
};

export const priority = (r: string): number =>
  /^package\.json$/.test(r)
    ? 0
    : /(^|\/)(tsconfig|next\.config|vite\.config|tailwind\.config|Dockerfile)/.test(
          r
        )
      ? 1
      : /(^|\/)(app|src)\//.test(r)
        ? 2
        : 3;

// Per-process random tag suffix so file contents never collide with XML proposal tags
const globalForKey = globalThis as unknown as { __BUILDER_TAG_KEY?: string };
if (!globalForKey.__BUILDER_TAG_KEY) {
  globalForKey.__BUILDER_TAG_KEY =
    "zt" + crypto.randomBytes(4).toString("hex");
}
export const TAG_KEY = globalForKey.__BUILDER_TAG_KEY;
export const TF = `file_${TAG_KEY}`;
export const TD = `delete_${TAG_KEY}`;
export const TC = `cmd_${TAG_KEY}`;
export const TN = `next_${TAG_KEY}`;