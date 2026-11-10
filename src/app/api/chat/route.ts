import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import {
  getOrCreateSession,
  persistSessionDebounced,
} from "@/lib/session-store";
import {
  getVertexAuthHealthStatus,
  MAX_FILE_BYTES,
  MAX_OUTPUT_TOKENS,
  MAX_PROMPT_CHARS,
  MODEL,
  resolveVertexAuthOptions,
  TAG_KEY,
  TC,
  TD,
  TF,
  TN,
  TOTAL_CHAR_BUDGET,
} from "@/lib/config";
import {
  buildDelta,
  buildSnapshot,
  ctxInfo,
  estChars,
  isBinaryBuffer,
  walk,
} from "@/lib/workspace";
import { safeResolve } from "@/lib/security";
import {
  buildSystemPrompt,
  cleanForDisplay,
  compactModelTurnForHistory,
  extractProposals,
  findUnclosedFileTag,
  NEXT_RE,
  stitchContinuation,
  stripThinkingPreamble,
} from "@/lib/proposals";
import {
  appendChatTurnToDisk,
  dehydrateSessionInRam,
  getBlob,
  getStorageStats,
  hydrateProposal,
  putBlob,
  saveAttachmentToDisk,
  saveProposalToDisk,
  saveSnapshotToDisk,
  syncProposalsFromDisk,
} from "@/lib/disk-store";
import type {
  AttachmentMeta,
  AttachmentPayload,
  BuilderSession,
  ChatMode,
  HistoryTurn,
  OperationChip,
} from "@/types/builder";

// Allow long-running streaming generations up to 5 minutes without route timeout
export const maxDuration = 300;

function createVertexClient(workspaceRoot?: string | null): GoogleGenAI {
  const authCfg = resolveVertexAuthOptions(workspaceRoot);
  const savedGoogleApiKey = process.env.GOOGLE_API_KEY;
  const savedGeminiApiKey = process.env.GEMINI_API_KEY;
  if (authCfg.googleAuthOptions) {
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  }
  try {
    return new GoogleGenAI({
      vertexai: true,
      project: authCfg.project,
      location: authCfg.location,
      ...(authCfg.googleAuthOptions
        ? { googleAuthOptions: authCfg.googleAuthOptions }
        : {}),
    });
  } finally {
    if (savedGoogleApiKey !== undefined) {
      process.env.GOOGLE_API_KEY = savedGoogleApiKey;
    }
    if (savedGeminiApiKey !== undefined) {
      process.env.GEMINI_API_KEY = savedGeminiApiKey;
    }
  }
}

/**
 * Extracts only visible non-thought text from a `@google/genai` stream chunk.
 * Prevents internal `part.thought === true` reasoning parts from leaking into file contents!
 */
function extractVisibleChunkText(chunk: unknown): string {
  const c = chunk as {
    text?: string;
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string; thought?: boolean }>;
      };
    }>;
  };
  const parts = c?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts) && parts.length > 0) {
    let out = "";
    for (const part of parts) {
      if (part && part.thought === true) continue;
      if (typeof part?.text === "string") {
        out += part.text;
      }
    }
    return out;
  }
  return typeof c?.text === "string" ? c.text : "";
}

/**
 * Rewrites any historical `<file_zt...>`, `<delete_zt...>`, `<cmd_zt...>`, `<next_zt...>` tags
 * in loaded session history to match the current process `TAG_KEY` AND compacts bulky `<file_...>`
 * bodies into lightweight File Receipts so old turns never waste tokens or RAM.
 */
function normalizeAndCompactTurnPairs(history: HistoryTurn[]): HistoryTurn[] {
  const unifyTags = (text: string) =>
    text
      .replace(/(<\/?)file_zt[0-9a-fA-F]{6,16}\b/g, `$1${TF}`)
      .replace(/(<\/?)delete_zt[0-9a-fA-F]{6,16}\b/g, `$1${TD}`)
      .replace(/(<\/?)cmd_zt[0-9a-fA-F]{6,16}\b/g, `$1${TC}`)
      .replace(/(<\/?)next_zt[0-9a-fA-F]{6,16}\b/g, `$1${TN}`);

  const pairs: HistoryTurn[] = [];
  for (let i = 0; i < history.length; i++) {
    const cur = history[i];
    const next = history[i + 1];
    if (cur && cur.role === "user" && next && next.role === "model") {
      // Strip bulky snapshot/delta/pinned preamble from older user turns in history so we only keep
      // the user's actual request and concise event context in history
      const rawUser = unifyTags(cur.parts?.[0]?.text || "");
      const reqIdx = rawUser.indexOf("=== USER REQUEST");
      const compactUser =
        reqIdx > 0
          ? rawUser.slice(0, Math.min(reqIdx, 600)) + "\n" + rawUser.slice(reqIdx)
          : rawUser;

      const rawModel = unifyTags(next.parts?.[0]?.text || "");
      const compactModel = compactModelTurnForHistory(rawModel);

      pairs.push(
        {
          role: "user",
          parts: [{ text: compactUser }],
        },
        {
          role: "model",
          parts: [{ text: compactModel }],
        }
      );
      i++;
    }
  }
  return pairs;
}

/**
 * Cache-Friendly 4-Turn Block Compaction:
 * Instead of shifting the sliding window by 1 turn on every message (which invalidates Vertex AI's
 * 75% Context Cache prefix on every turn), we compact older turns in stable 4-turn (8-message) blocks!
 */
function buildCompactedHistory(rawHistory: HistoryTurn[]): HistoryTurn[] {
  const history = normalizeAndCompactTurnPairs(rawHistory);
  const totalTurns = Math.floor(history.length / 2);
  if (totalTurns <= 8) return history;

  // Keep the most recent 6–9 turns intact and summarize older turns in fixed 4-turn blocks
  const compactedTurnCount = Math.floor((totalTurns - 6) / 4) * 4;
  if (compactedTurnCount <= 0) return history;

  const olderMsgCount = compactedTurnCount * 2;
  const older = history.slice(0, olderMsgCount);
  const recent = history.slice(olderMsgCount);

  const summaryLines: string[] = [];
  for (let i = 0; i < older.length; i += 2) {
    const u = older[i]?.parts?.[0]?.text || "";
    const m = older[i + 1]?.parts?.[0]?.text || "";
    const reqMatch = u.match(/=== USER REQUEST[\s\S]*?===\n([\s\S]*?)(\n\n|$)/);
    const shortUser = (reqMatch ? reqMatch[1] : u).trim().slice(0, 220);
    const shortModel = m.trim().slice(0, 360);
    summaryLines.push(
      `Turn #${Math.floor(i / 2) + 1}:\n- User: ${shortUser}\n- AI Outcome: ${shortModel}`
    );
  }

  return [
    {
      role: "user",
      parts: [
        {
          text: `=== COMPACTED ARCHITECTURAL & FILE LEDGER OF EARLIER TURNS (1 to ${compactedTurnCount}) ===\n${summaryLines.join("\n\n")}`,
        },
      ],
    },
    {
      role: "model",
      parts: [
        {
          text: "Understood. I have reviewed the compacted file ledger of earlier turns and will maintain full continuity with the recent turns and current workspace files.",
        },
      ],
    },
    ...recent,
  ];
}

/**
 * Builds:
 * 1. A compact live Workspace File Tree with byte sizes (so the AI knows all files & immediately sees any tiny stub files).
 * 2. Automatic On-Demand File Content blocks for any workspace file mentioned in `prompt` (even without `@`)!
 * 3. Previous version content from `s.undoStack` (`.zt-storage/blobs/`) if the user asks to compare/restore an earlier version.
 * 4. Currently unapproved pending proposals from `.zt-storage/sessions/<sid>/proposals/`.
 */
function buildOnDemandCodebaseContext(
  s: BuilderSession,
  prompt: string,
  alreadyPinnedPaths: Set<string>
): string {
  if (!s.root || s.readDenied) return "";
  const { files } = walk(s.root);
  files.sort((a, b) => a.rel.localeCompare(b.rel));

  const blocks: string[] = [];

  // 1. Live Workspace File Tree with byte sizes (~150 tokens)
  const treeLines = files.map((f) => {
    const stubFlag =
      f.size > 0 && f.size < 900 && f.rel.endsWith(".md")
        ? ` ⚠️ [SHORT/INCOMPLETE STUB: ${f.size} bytes]`
        : ` (${f.size} bytes)`;
    return `- ${f.rel}${stubFlag}`;
  });
  if (treeLines.length > 0) {
    blocks.push(
      `=== LIVE WORKSPACE FILE TREE (${files.length} files on disk) ===\n${treeLines.join("\n")}`
    );
  }

  // 2. Automatic Filename Detection in User Prompt (without needing `@`)
  const promptLower = prompt.toLowerCase();
  const wantsPrevVersion =
    /\b(previous|older|earlier|prior|before|revert|restore|history|version)\b/i.test(
      prompt
    );

  let autoLoadedBytes = 0;
  const MAX_AUTO_LOAD_BYTES = 120_000;

  for (const f of files) {
    if (alreadyPinnedPaths.has(f.rel)) continue;
    const baseName = path.basename(f.rel);
    const stem = baseName.replace(/\.[^.]+$/, "");
    // Match if the prompt mentions the relative path, the exact filename, or a distinctive stem (>= 5 chars)
    const matched =
      promptLower.includes(f.rel.toLowerCase()) ||
      promptLower.includes(baseName.toLowerCase()) ||
      (stem.length >= 5 && promptLower.includes(stem.toLowerCase()));

    if (matched && autoLoadedBytes + f.size <= MAX_AUTO_LOAD_BYTES) {
      try {
        const buf = fs.readFileSync(f.full);
        if (!isBinaryBuffer(buf)) {
          const content = buf.toString("utf-8");
          autoLoadedBytes += content.length;
          blocks.push(
            `--- AUTO-LOADED WORKSPACE FILE (referenced in prompt): ${f.rel} (${f.size} bytes) ---\n${content}`
          );

          // 3. If the user asked about a previous version of this file, also load its latest backup from s.undoStack
          if (wantsPrevVersion) {
            const undoEntry = [...s.undoStack]
              .reverse()
              .find((u) => u.rel === f.rel && (u.prevHash || u.prev));
            if (undoEntry) {
              const prevContent =
                undoEntry.prev ?? getBlob(undoEntry.prevHash ?? null);
              if (prevContent) {
                blocks.push(
                  `--- PREVIOUS VERSION FROM UNDO HISTORY (.zt-storage/blobs): ${f.rel} ---\n${prevContent.slice(0, 30_000)}`
                );
              }
            }
          }
        }
      } catch {
        // ignore unreadable
      }
    }
  }

  // 4. Attach any unapproved pending proposals (hydrated from disk on demand) if the user references them
  syncProposalsFromDisk(s);
  const pendingList = Object.values(s.pendingChanges);
  if (pendingList.length > 0) {
    const pendingSummary = pendingList
      .map((p) => `- ${p.relPath} (${p.action}, Turn #${p.turn})`)
      .join("\n");
    blocks.push(
      `=== UNAPPROVED PENDING PROPOSALS WAITING FOR USER REVIEW ===\n${pendingSummary}`
    );
    for (const rawP of pendingList) {
      const base = path.basename(rawP.relPath).toLowerCase();
      if (
        promptLower.includes(rawP.relPath.toLowerCase()) ||
        promptLower.includes(base)
      ) {
        const hydrated = hydrateProposal({ ...rawP });
        if (
          hydrated.content &&
          autoLoadedBytes + hydrated.content.length <= MAX_AUTO_LOAD_BYTES
        ) {
          autoLoadedBytes += hydrated.content.length;
          blocks.push(
            `--- PENDING UNAPPROVED PROPOSAL CONTENT: ${hydrated.relPath} ---\n${hydrated.content}`
          );
        }
      }
    }
  }

  return blocks.join("\n\n");
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { session: s, error, status } = getOrCreateSession(req, body.sid);
  if (!s) return NextResponse.json({ error }, { status: status || 400 });

  if (!s.root) {
    return NextResponse.json(
      { error: "Lock a workspace folder first!" },
      { status: 403 }
    );
  }
  if (s.busy) {
    return NextResponse.json(
      { error: "Still working on the previous request." },
      { status: 409 }
    );
  }

  const chatMode: ChatMode = body.chatMode === "talk" ? "talk" : "build";
  const askBeforeCritical = body.askBeforeCritical !== false;

  const selectedModel =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : MODEL;

  const rawAttachments: AttachmentPayload[] = Array.isArray(body.attachments)
    ? body.attachments
    : Array.isArray(body.images)
      ? body.images.map(
          (
            img: { mime?: string; data?: string; name?: string },
            idx: number
          ) => ({
            id: `img_${Date.now()}_${idx}`,
            name: img.name || `image-${idx + 1}`,
            mime: img.mime || "image/png",
            size: img.data ? Math.round((img.data.length * 3) / 4) : 0,
            kind: "image" as const,
            data: img.data,
          })
        )
      : [];

  const validMediaParts: Array<{
    inlineData: { mimeType: string; data: string };
  }> = [];
  const textAttachmentBlocks: string[] = [];
  const attachmentMetas: AttachmentMeta[] = [];

  for (const att of rawAttachments) {
    if (!att || typeof att.mime !== "string") continue;
    const attId =
      att.id || `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const name = String(att.name || "attachment");
    const size = Number(att.size) || 0;
    const kind = att.kind || "binary";

    let diskUrl: string | undefined = undefined;
    if (typeof att.data === "string" && att.data.length > 0) {
      diskUrl =
        saveAttachmentToDisk(s.id, attId, name, att.mime, att.data) ||
        undefined;
    }

    attachmentMetas.push({
      id: attId,
      name,
      mime: att.mime,
      size,
      kind,
      url: diskUrl,
    });

    if (typeof att.textContent === "string" && att.textContent.trim()) {
      textAttachmentBlocks.push(
        `--- ATTACHED FILE: ${name} (${att.mime}) ---\n${att.textContent}\n`
      );
    } else if (
      typeof att.data === "string" &&
      att.data.length > 0 &&
      /^(image|video|audio)\/|application\/pdf/.test(att.mime)
    ) {
      validMediaParts.push({
        inlineData: {
          mimeType: att.mime,
          data: att.data,
        },
      });
    }
  }

  const prompt =
    String(body.prompt || "")
      .trim()
      .slice(0, MAX_PROMPT_CHARS) ||
    (attachmentMetas.length
      ? `Please analyze the ${attachmentMetas.length} attached file(s)/media.`
      : "");

  if (!prompt) {
    return NextResponse.json({ error: "Empty prompt." }, { status: 400 });
  }

  // Extract explicit @file mentions from prompt and pin their exact fresh content
  const pinnedBlocks: string[] = [];
  const mentionMatches = [...prompt.matchAll(/@([A-Za-z0-9_./-\[\]]+)/g)];
  const seenMentions = new Set<string>();
  for (const m of mentionMatches) {
    const candidate = m[1].replace(/[.,;:!?]+$/, "");
    if (!candidate || seenMentions.has(candidate)) continue;
    seenMentions.add(candidate);
    try {
      const { resolved, rel } = safeResolve(s, candidate);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        const st = fs.statSync(resolved);
        if (st.size <= MAX_FILE_BYTES * 2) {
          const buf = fs.readFileSync(resolved);
          if (!isBinaryBuffer(buf)) {
            const content = buf.toString("utf-8");
            seenMentions.add(rel);
            pinnedBlocks.push(`--- PINNED @FILE: ${rel} ---\n${content}\n`);
          }
        }
      }
    } catch {
      // ignore invalid @mentions
    }
  }

  s.busy = true;
  const ac = new AbortController();
  s.abort = ac;
  const start = Date.now();

  let refreshed = false;
  if (!s.snapshot) {
    buildSnapshot(s, body.allowRead !== false);
    saveSnapshotToDisk(s.id, s.snapshot);
  } else if (!s.snapshot.text && s.snapshot.textHash) {
    const hydrated = getBlob(s.snapshot.textHash);
    if (hydrated) s.snapshot.text = hydrated;
    else {
      buildSnapshot(s, !s.readDenied);
      saveSnapshotToDisk(s.id, s.snapshot);
    }
  } else if (estChars(s) + prompt.length > TOTAL_CHAR_BUDGET) {
    buildSnapshot(s, !s.readDenied);
    saveSnapshotToDisk(s.id, s.snapshot);
    refreshed = true;
  }

  // Snapshot s.seen and s.events before buildDelta() so if the stream is aborted
  // or fails, we can roll them back and never lose delta/event context.
  const prevSeen = new Map(s.seen);
  const prevEvents = [...s.events];

  const delta = s.readDenied || refreshed ? null : buildDelta(s);
  const onDemandContext = buildOnDemandCodebaseContext(s, prompt, seenMentions);
  const ev = s.events.splice(0);
  let turnCommitted = false;

  const rollbackDeltaAndEvents = () => {
    if (turnCommitted) return;
    s.seen = prevSeen;
    s.events = [...prevEvents, ...s.events];
  };

  const modeReminder =
    chatMode === "talk"
      ? `(ACTIVE MODE: 💬 TALK / ARCHITECTURE PLANNING MODE. Discuss architecture, answer questions, or design an implementation plan. Use \`\`\`mermaid\`\`\` diagrams when illustrating architecture or flows. Do NOT emit file write/delete/cmd tags in this turn.)`
      : askBeforeCritical
        ? `(ACTIVE MODE: 🔨 BUILD MODE with Critical Confirmation Gate ON. Write every requested file to 100% completion—never output short stubs. For CHANGELOG.md, output ONLY the new ## section.)`
        : `(ACTIVE MODE: 🔨 BUILD MODE. Write every requested file to 100% completion—never output short stubs. For CHANGELOG.md, output ONLY the new ## section.)`;

  const userText =
    (ev.length
      ? `=== USER ACTIONS & COMMAND OUTPUTS SINCE LAST MESSAGE ===\n${ev.join("\n")}\n\n`
      : "") +
    (delta ? `${delta}\n\n` : "") +
    (onDemandContext ? `${onDemandContext}\n\n` : "") +
    (pinnedBlocks.length
      ? `=== PINNED WORKSPACE FILES (@MENTIONED BY USER) ===\n${pinnedBlocks.join("\n")}\n\n`
      : "") +
    (textAttachmentBlocks.length
      ? `=== USER ATTACHED FILES ===\n${textAttachmentBlocks.join("\n")}\n\n`
      : "") +
    `=== USER REQUEST [MODE: ${chatMode.toUpperCase()}] ===\n${prompt}\n\n` +
    `${modeReminder}`;

  const compactedHistory = buildCompactedHistory(s.history);

  const contents = [
    { role: "user", parts: [{ text: s.snapshot!.text }] },
    {
      role: "model",
      parts: [
        {
          text: "Project snapshot received. I will treat it as the project state and rely on later updates to stay in sync.",
        },
      ],
    },
    ...compactedHistory,
    {
      role: "user",
      parts: [{ text: userText }, ...validMediaParts],
    },
  ];

  const encoder = new TextEncoder();
  const sysInstruction = buildSystemPrompt(chatMode, askBeforeCritical);
  const authHealth = getVertexAuthHealthStatus(s.root, false);
  const ai = createVertexClient(s.root);

  // Cascade through highest-supported output token budgets so models capped at 32k/16k/8k
  // still use their maximum capacity instead of dropping to a tiny default limit.
  const tokenBudgetsToTry: Array<number | undefined> = Array.from(
    new Set([MAX_OUTPUT_TOKENS, 32768, 16384, 8192, undefined])
  );

  const runStreamPass = async (
    reqContents: Array<{ role: string; parts: Array<Record<string, unknown>> }>,
    onDelta?: (chunkText: string) => void
  ): Promise<{
    text: string;
    promptTokens: number;
    outputTokens: number;
    cachedTokens: number;
    finishReason: string;
    interruptedByError: boolean;
  }> => {
    let activeModel = selectedModel;
    let lastError: unknown = null;

    for (const tokenCap of tokenBudgetsToTry) {
      let passText = "";
      let promptTokens = 0;
      let outputTokens = 0;
      let cachedTokens = 0;
      let finishReason = "";

      try {
        const stream = await ai.models.generateContentStream({
          model: activeModel,
          contents: reqContents,
          config: {
            systemInstruction: sysInstruction,
            ...(tokenCap !== undefined ? { maxOutputTokens: tokenCap } : {}),
            abortSignal: ac.signal,
          },
        });

        for await (const chunk of stream) {
          const t = extractVisibleChunkText(chunk);
          if (t) {
            passText += t;
            onDelta?.(t);
          }
          if (chunk.usageMetadata) {
            promptTokens =
              chunk.usageMetadata.promptTokenCount || promptTokens;
            outputTokens =
              chunk.usageMetadata.candidatesTokenCount || outputTokens;
            cachedTokens =
              chunk.usageMetadata.cachedContentTokenCount || cachedTokens;
          }
          const candFinish = chunk.candidates?.[0]?.finishReason;
          if (candFinish) {
            finishReason = String(candFinish);
          }
        }

        return {
          text: stripThinkingPreamble(passText),
          promptTokens,
          outputTokens,
          cachedTokens,
          finishReason,
          interruptedByError: false,
        };
      } catch (err: unknown) {
        lastError = err;
        if (ac.signal.aborted) throw err;

        // If we already received substantial text before a mid-stream network/timeout glitch,
        // return the partial text so the auto-continuation loop can seamlessly resume it!
        if (passText.length > 200) {
          return {
            text: stripThinkingPreamble(passText),
            promptTokens,
            outputTokens,
            cachedTokens,
            finishReason: "INTERRUPTED",
            interruptedByError: true,
          };
        }

        const errStr = err instanceof Error ? err.message : String(err);
        if (
          activeModel !== MODEL &&
          (errStr.includes("404") || errStr.includes("NOT_FOUND"))
        ) {
          activeModel = MODEL;
          continue;
        }
        if (
          /max_output_tokens|maxOutputTokens|INVALID_ARGUMENT|out of range|maximum/i.test(
            errStr
          )
        ) {
          continue;
        }
        throw err;
      }
    }

    throw lastError || new Error("Failed to open Vertex AI content stream.");
  };

  const readable = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          // stream already closed
        }
      };

      try {
        send({
          t: "meta",
          ctx: ctxInfo(s),
          delta: !!delta,
          refreshed,
          mode: chatMode,
          tagKey: TAG_KEY,
        });

        // Pre-flight check: if .env or key file has a corrupted PEM key, fail fast with a clear explanation
        if (authHealth.source !== "missing" && !authHealth.validPemKey) {
          throw new Error(
            `Invalid GOOGLE_PRIVATE_KEY in ${authHealth.sourceLabel}: ${authHealth.pemError || "OpenSSL could not decode PEM key"}. Make sure you copied the entire "private_key" value (from "-----BEGIN PRIVATE KEY-----" through "-----END PRIVATE KEY-----") from your Google Cloud Service Account JSON into .env, then click the 🔑 badge in the top bar -> "Reload .env".`
          );
        }

        // Pass 0: Initial stream
        const initialPass = await runStreamPass(contents, (t) =>
          send({ t: "d", x: t })
        );

        let full = initialPass.text;
        let totalPromptTokens = initialPass.promptTokens;
        let totalOutputTokens = initialPass.outputTokens;
        let totalCachedTokens = initialPass.cachedTokens;
        let lastFinishReason = initialPass.finishReason;

        // SEAMLESS TAIL-APPEND AUTO-CONTINUATION (Up to 5 passes):
        // Never discard already-generated partial file content! Instead, keep `full` intact,
        // feed the exact tail context to the model, and stitch the continuation seamlessly.
        const MAX_CONTINUATION_PASSES = 5;
        for (let pass = 1; pass <= MAX_CONTINUATION_PASSES; pass++) {
          if (ac.signal.aborted) break;

          const truncCheck = findUnclosedFileTag(full);
          const hitTokenCap =
            lastFinishReason === "MAX_TOKENS" ||
            lastFinishReason === "LENGTH" ||
            lastFinishReason === "INTERRUPTED";

          if (!truncCheck.unclosed && !hitTokenCap) {
            break;
          }

          const tailContext = full.slice(-1200);
          const continueInstruction = truncCheck.unclosed
            ? `SYSTEM AUTO-CONTINUE (Pass ${pass}/${MAX_CONTINUATION_PASSES}): Your response stopped mid-file inside <${TF} path="${truncCheck.path}"> right at the end of this excerpt:\n<<<TAIL_START>>>\n${tailContext}\n<<<TAIL_END>>>\n\nCRITICAL INSTRUCTIONS:\n1. Output ONLY the raw continuation characters starting immediately after <<<TAIL_END>>>.\n2. Do NOT output "Thinking Process:", commentary, or markdown fences around your continuation, and do NOT re-open <${TF} path="${truncCheck.path}">.\n3. Finish writing the rest of "${truncCheck.path}", close it with </${TF}> on its own line, and then output any remaining requested <${TF} path="...">...</${TF}> files and CHANGELOG.md.`
            : `SYSTEM AUTO-CONTINUE (Pass ${pass}/${MAX_CONTINUATION_PASSES}): Your response hit the output token limit right at the end of this excerpt:\n<<<TAIL_START>>>\n${tailContext}\n<<<TAIL_END>>>\n\nContinue seamlessly from the exact character immediately after <<<TAIL_END>>> without outputting "Thinking Process:" or repeating already-completed text.`;

          const contContents = [
            ...contents,
            {
              role: "model",
              parts: [{ text: full }],
            },
            {
              role: "user",
              parts: [{ text: continueInstruction }],
            },
          ];

          const contPass = await runStreamPass(contContents);
          totalPromptTokens = contPass.promptTokens || totalPromptTokens;
          totalOutputTokens += contPass.outputTokens;
          totalCachedTokens = Math.max(
            totalCachedTokens,
            contPass.cachedTokens
          );
          lastFinishReason = contPass.finishReason;

          if (!contPass.text.trim()) {
            break;
          }

          const { merged, appendedDelta } = stitchContinuation(
            full,
            contPass.text,
            truncCheck,
            TF
          );

          // Guard against zero forward progress
          if (merged.length <= full.length) {
            break;
          }

          full = merged;
          if (appendedDelta) {
            send({ t: "d", x: appendedDelta });
          }
        }

        if (!full.trim()) {
          throw new Error(
            "The model returned an empty response. Try rephrasing."
          );
        }

        const turn = Math.floor(s.history.length / 2) + 1;
        const { proposals, commands, blocked } = extractProposals(
          s,
          full,
          turn,
          chatMode
        );

        // Immediately persist all proposed files into .zt-storage/blobs/ and .zt-storage/sessions/<sid>/proposals/
        for (const p of proposals) {
          p.contentHash = putBlob(p.content ?? null);
          p.oldContentHash = putBlob(p.oldContent ?? null);
          saveProposalToDisk(s.id, p);
        }

        const duration = ((Date.now() - start) / 1000).toFixed(1);
        const next = [...full.matchAll(NEXT_RE)]
          .map((m) => m[1].trim())
          .filter(Boolean)
          .slice(0, 3);

        // Store compact user request + File-Receipt model summary in `s.history` & `history.jsonl`
        // so we never waste tokens or RAM storing 10,000-byte raw <file_...> bodies in history!
        const compactHistUserText =
          (ev.length ? `Events:\n${ev.join("\n")}\n\n` : "") +
          `=== USER REQUEST [MODE: ${chatMode.toUpperCase()}] ===\n${prompt}` +
          (attachmentMetas.length
            ? `\n[Attached ${attachmentMetas.length} file(s): ${attachmentMetas.map((a) => a.name).join(", ")}]`
            : "");
        const compactHistModelText = compactModelTurnForHistory(full);

        const userHist: HistoryTurn = {
          role: "user",
          parts: [{ text: compactHistUserText }],
        };
        const modelHist: HistoryTurn = {
          role: "model",
          parts: [{ text: compactHistModelText }],
        };
        s.history.push(userHist, modelHist);
        turnCommitted = true;

        let clean = cleanForDisplay(full, chatMode);
        if (blocked.length) {
          clean += "\n\n" + blocked.map((b) => `> ${b}`).join("\n");
        }

        const ts = Date.now();
        const ops: OperationChip[] = [
          ...proposals.map((p) => ({
            id: p.id,
            kind: p.kind,
            relPath: p.relPath,
            status: "pending" as const,
            isCritical: p.isCritical,
          })),
          ...commands.map((c) => ({
            id: c.id,
            kind: "cmd" as const,
            command: c.command,
            status: "pending" as const,
          })),
        ];

        const userDisplay = {
          role: "user" as const,
          text: prompt,
          ts,
          mode: chatMode,
          images: attachmentMetas.length,
          attachments: attachmentMetas,
        };
        const modelDisplay = {
          role: "model" as const,
          text: clean,
          duration,
          ts,
          mode: chatMode,
          ops,
          next,
        };
        s.display.push(userDisplay, modelDisplay);

        // O(1) append to disk JSONL files immediately
        appendChatTurnToDisk(
          s.id,
          userDisplay,
          modelDisplay,
          userHist,
          modelHist
        );

        if (totalPromptTokens > 0 || totalOutputTokens > 0) {
          s.usage.last = {
            prompt: totalPromptTokens,
            output: totalOutputTokens,
            cached: totalCachedTokens,
          };
          s.usage.prompt += s.usage.last.prompt;
          s.usage.output += s.usage.last.output;
          s.usage.cached += s.usage.last.cached;
        }

        // Send hydrated proposals to the client in `{ t: "done" }` FIRST,
        // and then dehydrate `s.pendingChanges` & `s.snapshot.text` in RAM so Node.js RAM stays completely free!
        send({
          t: "done",
          text: clean,
          mode: chatMode,
          proposals,
          commands,
          ops,
          next,
          ts,
          turns: Math.floor(s.history.length / 2),
          duration,
          usage: s.usage,
          ctx: ctxInfo(s),
          storage: getStorageStats(),
          userAttachments: attachmentMetas,
        });

        dehydrateSessionInRam(s);
        persistSessionDebounced(s.id, false);
      } catch (e: unknown) {
        rollbackDeltaAndEvents();
        let msg = e instanceof Error ? e.message : String(e);
        if (/Could not load the default credentials/i.test(msg)) {
          msg +=
            " — Copy `.env.example` to `.env` and fill in your GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, and GOOGLE_PROJECT_ID (or place `vertex_credentials.json` in the project root).";
        } else if (
          /1E08010C|DECODER routines::unsupported/i.test(msg)
        ) {
          msg =
            "OpenSSL failed to decode GOOGLE_PRIVATE_KEY (`error:1E08010C:DECODER routines::unsupported`). Please check `GOOGLE_PRIVATE_KEY` in your `.env` file and ensure the full RSA key between `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` is intact, then click the 🔑 badge in the top bar -> 'Reload .env & Verify Now'.";
        }
        send({ t: "error", error: msg });
      } finally {
        s.busy = false;
        s.abort = null;
        try {
          controller.close();
        } catch {
          // ignore
        }
      }
    },
    cancel() {
      rollbackDeltaAndEvents();
      ac.abort();
      s.busy = false;
      s.abort = null;
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}