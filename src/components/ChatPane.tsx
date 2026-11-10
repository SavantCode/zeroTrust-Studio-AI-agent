"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  isSoundEnabled,
  notifyAiCompletion,
  onCompletionToast,
  onNotificationPrefChange,
  playCompletionSound,
  requestDesktopNotificationPermission,
  setSoundEnabled,
  unlockAudioContext,
  type CompletionToastPayload,
} from "@/lib/notifications";
import type {
  AttachmentPayload,
  ChatMode,
  DisplayMessage,
  OperationChip,
} from "@/types/builder";
import type { EnrichedProposal } from "@/lib/diff";

interface ChatPaneProps {
  widthPct: number;
  isFullWidth: boolean;
  chatMode: ChatMode;
  setChatMode: (mode: ChatMode) => void;
  askBeforeCritical: boolean;
  setAskBeforeCritical: (v: boolean) => void;
  files: string[];
  messages: DisplayMessage[];
  streamingText: string | null;
  busy: boolean;
  prompt: string;
  setPrompt: (v: string) => void;
  attachments: AttachmentPayload[];
  onAddFiles: (files: FileList | File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onClearAttachments: () => void;
  onSend: (overridePrompt?: string, overrideMode?: ChatMode) => void;
  onRetryLast: (editOnly: boolean) => void;
  onCopy: (text: string) => void;
  onOpenReview: (id: string) => void;
  onCloseChat?: () => void;
  pendingProps: Record<string, EnrichedProposal>;
  currentFilesCount: number;
}

const timeStr = (ts?: number) =>
  new Date(ts || Date.now()).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

function balanceFences(md: string): string {
  const fences = md.match(/^```/gm);
  if (fences && fences.length % 2 !== 0) {
    return md + "\n```";
  }
  return md;
}

function renderSafeMarkdown(mdText: string): string {
  const safeMd = balanceFences(mdText || "…");
  const rawHtml = marked.parse(safeMd, {
    async: false,
    breaks: true,
    gfm: true,
  }) as string;
  if (typeof window === "undefined") return rawHtml;
  return DOMPurify.sanitize(rawHtml, {
    FORBID_TAGS: [
      "img",
      "picture",
      "style",
      "form",
      "input",
      "button",
      "iframe",
      "svg",
      "math",
      "link",
      "meta",
    ],
    FORBID_ATTR: ["style", "srcset"],
  });
}

function StreamingTimer({ label }: { label?: string }) {
  const [elapsed, setElapsed] = useState("0.0");
  useEffect(() => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      setElapsed(((Date.now() - t0) / 1000).toFixed(1));
    }, 200);
    return () => clearInterval(iv);
  }, []);
  return (
    <span>
      {label ? `${label} ` : ""}
      {elapsed}s
    </span>
  );
}

let mermaidPromise: Promise<unknown> | null = null;
function loadMermaid(): Promise<{
  render: (id: string, code: string) => Promise<{ svg: string }>;
}> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("No window"));
  }
  const w = window as unknown as {
    mermaid?: {
      initialize: (cfg: Record<string, unknown>) => void;
      render: (id: string, code: string) => Promise<{ svg: string }>;
    };
  };
  if (w.mermaid) return Promise.resolve(w.mermaid);
  if (!mermaidPromise) {
    mermaidPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js";
      s.onload = () => {
        if (w.mermaid) {
          w.mermaid.initialize({ startOnLoad: false, theme: "dark" });
          resolve(w.mermaid);
        } else reject(new Error("Mermaid failed to initialize"));
      };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  return mermaidPromise as Promise<{
    render: (id: string, code: string) => Promise<{ svg: string }>;
  }>;
}

const MarkdownContent = React.memo(
  function MarkdownContent({
    text,
    onCopy,
    isStreaming,
  }: {
    text: string;
    onCopy: (t: string) => void;
    isStreaming?: boolean;
  }) {
    const ref = useRef<HTMLDivElement>(null);
    const sanitizedHtml = useMemo(() => renderSafeMarkdown(text), [text]);

    useEffect(() => {
      if (isStreaming) return;
      const el = ref.current;
      if (!el) return;
      el.querySelectorAll("pre").forEach((pre) => {
        if (!pre.querySelector(".code-copy-btn")) {
          pre.style.position = "relative";
          const codeEl = pre.querySelector("code");
          const rawCode = codeEl
            ? codeEl.textContent || ""
            : pre.textContent || "";

          const btn = document.createElement("button");
          btn.className =
            "code-copy-btn absolute top-1.5 right-1.5 text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-2 py-0.5 rounded z-10";
          btn.textContent = "Copy";
          btn.onclick = (ev) => {
            ev.stopPropagation();
            onCopy(rawCode);
          };
          pre.appendChild(btn);
        }

        const codeEl = pre.querySelector("code");
        const rawCode = codeEl
          ? codeEl.textContent || ""
          : pre.textContent.replace(/Copy$/, "") || "";

        if (
          codeEl &&
          codeEl.className.includes("language-mermaid") &&
          !pre.dataset.mermaidRendered
        ) {
          pre.dataset.mermaidRendered = "1";
          loadMermaid()
            .then(async (m) => {
              const id = `mmd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
              const { svg } = await m.render(id, rawCode.trim());
              const diagramBox = document.createElement("div");
              diagramBox.className =
                "my-2 p-3 bg-slate-950 border border-indigo-500/30 rounded-lg overflow-x-auto";
              diagramBox.innerHTML = svg;
              pre.parentNode?.insertBefore(diagramBox, pre);
              pre.style.display = "none";

              const toggleBtn = document.createElement("button");
              toggleBtn.className =
                "text-[10px] text-indigo-300 hover:underline mb-2 block font-mono";
              toggleBtn.textContent = "📝 Toggle Mermaid Source";
              toggleBtn.onclick = () => {
                pre.style.display =
                  pre.style.display === "none" ? "block" : "none";
              };
              diagramBox.parentNode?.insertBefore(toggleBtn, pre);
            })
            .catch(() => {
              // keep raw code block if mermaid syntax is invalid
            });
        }
      });
    }, [sanitizedHtml, onCopy, isStreaming]);

    return (
      <div
        ref={ref}
        className="rounded-2xl px-4 py-3 text-sm bg-slate-900/95 border border-slate-800 text-slate-200 md min-w-0 max-w-full overflow-x-auto shadow-sm"
        dangerouslySetInnerHTML={{
          __html: sanitizedHtml,
        }}
      />
    );
  },
  (prev, next) =>
    prev.text === next.text && prev.isStreaming === next.isStreaming
);

export default function ChatPane({
  widthPct,
  isFullWidth,
  chatMode,
  setChatMode,
  askBeforeCritical,
  setAskBeforeCritical,
  files,
  messages,
  streamingText,
  busy,
  prompt,
  setPrompt,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  onClearAttachments,
  onSend,
  onRetryLast,
  onCopy,
  onOpenReview,
  onCloseChat,
  pendingProps,
  currentFilesCount,
}: ChatPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const msgRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const prevBusyRef = useRef<boolean>(false);
  const prevMsgCountRef = useRef<number>(messages.length);

  const [stickToBottom, setStickToBottom] = useState(true);
  const [histIdx, setHistIdx] = useState(-1);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [soundOn, setSoundOn] = useState<boolean>(true);
  const [completionToast, setCompletionToast] =
    useState<CompletionToastPayload | null>(null);

  // Chat Search & Filter State
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterOnlyMatches, setFilterOnlyMatches] = useState(false);
  const [activeMatchCursor, setActiveMatchCursor] = useState(0);

  // Sync sound preference across components
  useEffect(() => {
    setSoundOn(isSoundEnabled());
    return onNotificationPrefChange(() => {
      setSoundOn(isSoundEnabled());
    });
  }, []);

  // Listen for completion toast events and auto-dismiss after 4.5s
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = onCompletionToast((toast) => {
      setCompletionToast(toast);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setCompletionToast(null);
      }, 4500);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Detect when AI finishes building, thinking, or responding (busy: true -> false)
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    const prevCount = prevMsgCountRef.current;
    prevBusyRef.current = busy;
    prevMsgCountRef.current = messages.length;

    if (wasBusy && !busy) {
      if (messages.length > prevCount) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === "model") {
          const opsCount = lastMsg.ops ? lastMsg.ops.length : 0;
          const fileOps = (lastMsg.ops || []).filter(
            (o) => o.kind === "write" || o.kind === "delete"
          ).length;
          const cmdOps = (lastMsg.ops || []).filter(
            (o) => o.kind === "cmd"
          ).length;
          const durText = lastMsg.duration ? ` in ${lastMsg.duration}s` : "";

          if (lastMsg.mode === "talk") {
            notifyAiCompletion({
              kind: "talk",
              title: "💬 AI Finished Thinking & Responding",
              subtitle: `Architecture & plan reply ready${durText}.`,
            });
          } else if (opsCount > 0) {
            const parts: string[] = [];
            if (fileOps > 0) {
              parts.push(`${fileOps} file${fileOps === 1 ? "" : "s"}`);
            }
            if (cmdOps > 0) {
              parts.push(`${cmdOps} command${cmdOps === 1 ? "" : "s"}`);
            }
            notifyAiCompletion({
              kind: "build",
              title: "🔨 AI Finished Building!",
              subtitle: `Proposed ${parts.join(" & ")}${durText} — ready for review.`,
            });
          } else {
            notifyAiCompletion({
              kind: "talk",
              title: "✅ AI Response Ready",
              subtitle: `Completed reply${durText}.`,
            });
          }
        }
      }
    }
  }, [busy, messages]);

  const handleToggleSound = async () => {
    unlockAudioContext();
    const next = !soundOn;
    setSoundEnabled(next);
    setSoundOn(next);
    if (next) {
      playCompletionSound("build", true);
      await requestDesktopNotificationPermission();
    }
  };

  const triggerSend = (overridePrompt?: string, overrideMode?: ChatMode) => {
    unlockAudioContext();
    requestDesktopNotificationPermission().catch(() => {});
    onSend(overridePrompt, overrideMode);
  };

  const matchingIndices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const out: number[] = [];
    messages.forEach((m, idx) => {
      const inText = m.text.toLowerCase().includes(q);
      const inOps = (m.ops || []).some(
        (o) =>
          (o.relPath && o.relPath.toLowerCase().includes(q)) ||
          (o.command && o.command.toLowerCase().includes(q))
      );
      if (inText || inOps) out.push(idx);
    });
    return out;
  }, [messages, searchQuery]);

  const jumpToMessageIndex = (msgIdx: number) => {
    setStickToBottom(false);
    requestAnimationFrame(() => {
      const el = msgRefs.current[msgIdx];
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  };

  const stepSearchMatch = (dir: 1 | -1) => {
    if (!matchingIndices.length) return;
    const nextCursor =
      (activeMatchCursor + dir + matchingIndices.length) %
      matchingIndices.length;
    setActiveMatchCursor(nextCursor);
    jumpToMessageIndex(matchingIndices[nextCursor]);
  };

  // Detect active @file token near cursor for autocomplete
  const mentionQuery = useMemo(() => {
    const m = prompt.match(/(?:^|\s)@([A-Za-z0-9_./-\[\]]*)$/);
    return m ? m[1] : null;
  }, [prompt]);

  const mentionMatches = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return files.filter((f) => f.toLowerCase().includes(q)).slice(0, 8);
  }, [files, mentionQuery]);

  const insertMention = (relPath: string) => {
    const nextPrompt = prompt.replace(
      /(?:^|\s)@([A-Za-z0-9_./-\[\]]*)$/,
      (full) => (full.startsWith(" ") ? ` @${relPath} ` : `@${relPath} `)
    );
    setPrompt(nextPrompt);
    setMentionIdx(0);
    textareaRef.current?.focus();
  };

  useEffect(() => {
    if (!stickToBottom || !containerRef.current) return;
    const c = containerRef.current;
    const rafId = requestAnimationFrame(() => {
      c.scrollTop = c.scrollHeight;
    });
    return () => cancelAnimationFrame(rafId);
  }, [messages, streamingText, stickToBottom]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }, [prompt]);

  const scrollDown = () => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      setStickToBottom(true);
    }
  };

  const ideas =
    chatMode === "talk"
      ? [
          "Draw a Mermaid architecture diagram of this project",
          "Review our current architecture and suggest improvements",
          "Let's plan a new feature before writing any code",
          "What are the security or scalability bottlenecks here?",
        ]
      : currentFilesCount > 0
        ? [
            "Explain how this project is structured",
            "Find bugs and suggest fixes",
            "Add a new feature or UI improvement",
            "Write a comprehensive README",
          ]
        : [
            "Build a landing page with HTML, CSS and JS",
            "Create a todo app with React + Vite",
            "Build a Next.js dashboard with charts",
            "Make a simple Express REST API",
          ];

  let lastModelIdx = -1;
  messages.forEach((m, i) => {
    if (m.role === "model") lastModelIdx = i;
  });

  const renderChip = (o: OperationChip) => {
    const st = o.status;
    const clsMap: Record<string, string> = {
      pending:
        "border-amber-500/50 text-amber-200 bg-amber-950/30 hover:bg-amber-900/40 cursor-pointer",
      approved: "border-emerald-600/50 text-emerald-300 bg-emerald-950/30",
      ran: "border-emerald-600/50 text-emerald-300 bg-emerald-950/30",
      denied: "border-slate-700 text-slate-500 line-through",
      undone: "border-slate-700 text-slate-400",
      superseded: "border-slate-800 text-slate-600 line-through",
    };
    const labelMap: Record<string, string> = {
      pending: "review",
      approved: "applied",
      ran: "ran",
      denied: "denied",
      undone: "undone",
      superseded: "replaced",
    };
    const pp = pendingProps[o.id];
    const isCrit = o.isCritical || pp?.isCritical || o.kind === "delete";
    return (
      <button
        key={o.id}
        onClick={() => {
          if (o.status === "pending") {
            onOpenReview(o.kind === "cmd" ? "cmds" : o.id);
          }
        }}
        className={`text-[11px] font-mono px-2.5 py-1 rounded-lg border flex items-center gap-1.5 max-w-full transition-colors ${clsMap[st] || "border-slate-700 text-slate-400"}`}
      >
        <span>
          {o.kind === "cmd" ? "⚡" : o.kind === "delete" ? "🗑️" : "📄"}
        </span>
        {isCrit && st === "pending" && (
          <span className="bg-rose-600/40 text-rose-200 border border-rose-500/50 px-1 rounded text-[9px] font-bold">
            ⚠️ CRITICAL
          </span>
        )}
        <span className="truncate">
          {o.kind === "cmd" ? o.command : o.relPath}
        </span>
        {st === "pending" && pp && (
          <>
            <span className="text-emerald-400">+{pp._add}</span>
            <span className="text-rose-400">−{pp._del}</span>
          </>
        )}
        <span className="text-[10px] opacity-80">{labelMap[st] || st}</span>
      </button>
    );
  };

  const userMessages = messages.filter((m) => m.role === "user");
  const matchSet = useMemo(() => new Set(matchingIndices), [matchingIndices]);
  const focusedMsgIndex =
    matchingIndices.length > 0 ? matchingIndices[activeMatchCursor] : -1;

  return (
    <div
      style={{
        width: maximized || isFullWidth ? "100%" : `${widthPct}%`,
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDraggingOver(true);
      }}
      onDragLeave={() => setIsDraggingOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDraggingOver(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          onAddFiles(e.dataTransfer.files);
        }
      }}
      className={`${
        maximized ? "fixed inset-0 z-30 bg-slate-950" : "relative"
      } border-r border-slate-800 flex flex-col min-w-[260px] bg-slate-950`}
    >
      {/* Floating Completion Toast Notification */}
      {completionToast && (
        <div className="absolute top-11 right-3 z-40 max-w-xs bg-slate-900/95 border border-emerald-500/60 rounded-xl px-3.5 py-2.5 shadow-2xl flex items-start gap-2.5 backdrop-blur-md animate-bounce">
          <span className="text-base leading-none mt-0.5">
            {completionToast.kind === "build"
              ? "🔔"
              : completionToast.kind === "talk"
                ? "💬"
                : "⚠️"}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-emerald-300">
              {completionToast.title}
            </div>
            <div className="text-[11px] text-slate-300 leading-snug mt-0.5">
              {completionToast.subtitle}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setCompletionToast(null)}
            className="text-slate-400 hover:text-slate-200 text-xs"
          >
            ✕
          </button>
        </div>
      )}

      {/* Window Title Bar with Mode Switcher, Sound Toggle & Search Toggle */}
      <div className="px-3 py-1.5 bg-slate-900 border-b border-slate-800 text-[11px] text-slate-400 font-mono flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-300">
            {chatMode === "talk"
              ? "💬 Talk & Plan Mode"
              : "🔨 Build & Code Mode"}
          </span>
          {busy && (
            <span className="text-amber-400 animate-pulse">
              · streaming (<StreamingTimer />)
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleToggleSound}
            className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors flex items-center gap-1 ${
              soundOn
                ? "bg-emerald-950/80 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-900/60"
                : "bg-slate-800 border border-slate-700 text-slate-400 hover:text-slate-200"
            }`}
            title={
              soundOn
                ? "Completion Sound & Desktop Notification ON (click to mute)"
                : "Completion Sound & Desktop Notification Muted (click to enable & test chime)"
            }
          >
            <span>{soundOn ? "🔔" : "🔕"}</span>
            <span className="hidden sm:inline">
              {soundOn ? "Sound ON" : "Muted"}
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              setSearchOpen(!searchOpen);
              if (searchOpen) {
                setSearchQuery("");
                setFilterOnlyMatches(false);
              }
            }}
            className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors ${
              searchOpen
                ? "bg-sky-600 text-white"
                : "bg-slate-800 hover:bg-slate-700 text-slate-300"
            }`}
            title="Search or filter messages in this chat"
          >
            🔍 Search ({messages.length})
          </button>

          <div className="flex items-center bg-slate-950 border border-slate-700 rounded p-0.5">
            <button
              type="button"
              onClick={() => setChatMode("build")}
              className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                chatMode === "build"
                  ? "bg-emerald-600 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
              title="Build Mode: AI proposes file changes, deletes, and commands"
            >
              🔨 Build
            </button>
            <button
              type="button"
              onClick={() => setChatMode("talk")}
              className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                chatMode === "talk"
                  ? "bg-indigo-600 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
              title="Talk Mode: Discuss architecture & plan with Mermaid diagrams without touching files"
            >
              💬 Talk / Plan
            </button>
          </div>

          <button
            onClick={() => setMaximized(!maximized)}
            className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-0.5 rounded"
            title={maximized ? "Restore Chat Size" : "Maximize Chat Window"}
          >
            {maximized ? "🗗 Restore" : "🗖 Maximize"}
          </button>
          {onCloseChat && !maximized && (
            <button
              onClick={onCloseChat}
              className="bg-slate-800 hover:bg-rose-900/50 text-slate-400 hover:text-rose-200 px-2 py-0.5 rounded"
              title="Hide Chat Window"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Collapsible Chat Search & Filter Bar */}
      {searchOpen && (
        <div className="px-3 py-1.5 bg-slate-900/90 border-b border-slate-800 flex flex-wrap items-center gap-2 text-xs shrink-0">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setActiveMatchCursor(0);
              const q = e.target.value.trim().toLowerCase();
              if (q) {
                const firstIdx = messages.findIndex(
                  (m) =>
                    m.text.toLowerCase().includes(q) ||
                    (m.ops || []).some(
                      (o) =>
                        o.relPath?.toLowerCase().includes(q) ||
                        o.command?.toLowerCase().includes(q)
                    )
                );
                if (firstIdx >= 0 && !filterOnlyMatches) {
                  jumpToMessageIndex(firstIdx);
                }
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                stepSearchMatch(e.shiftKey ? -1 : 1);
              }
            }}
            placeholder="Find in chat messages or @files (Enter = next)…"
            className="flex-1 min-w-[160px] bg-slate-950 border border-slate-700 rounded px-2.5 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-sky-500"
            autoFocus
          />
          <span className="text-[11px] font-mono text-slate-400">
            {searchQuery.trim()
              ? matchingIndices.length > 0
                ? `${activeMatchCursor + 1}/${matchingIndices.length}`
                : "0 matches"
              : `${messages.length} msgs`}
          </span>
          <button
            type="button"
            disabled={!matchingIndices.length}
            onClick={() => stepSearchMatch(-1)}
            className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 px-2 py-0.5 rounded text-[11px]"
            title="Previous match"
          >
            ↑
          </button>
          <button
            type="button"
            disabled={!matchingIndices.length}
            onClick={() => stepSearchMatch(1)}
            className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 px-2 py-0.5 rounded text-[11px]"
            title="Next match"
          >
            ↓
          </button>
          <label className="flex items-center gap-1 text-[11px] text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={filterOnlyMatches}
              onChange={(e) => setFilterOnlyMatches(e.target.checked)}
              className="accent-sky-500"
            />
            <span>Filter only matches</span>
          </label>
          {searchQuery && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery("");
                setFilterOnlyMatches(false);
              }}
              className="text-slate-400 hover:text-slate-200 text-[11px] px-1"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {isDraggingOver && (
        <div className="absolute inset-0 z-20 bg-emerald-950/80 border-2 border-dashed border-emerald-400 flex items-center justify-center pointer-events-none">
          <div className="text-emerald-200 font-semibold text-sm">
            📂 Drop unlimited photos, videos, audio, PDFs, or code files here
          </div>
        </div>
      )}

      <main
        ref={containerRef}
        id="chat-container"
        onScroll={() => {
          const c = containerRef.current;
          if (!c) return;
          const nearBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 90;
          if (nearBottom !== stickToBottom) {
            setStickToBottom(nearBottom);
          }
        }}
        className="flex-1 overflow-y-auto p-4 gap-5"
      >
        {messages.length === 0 && !busy && (
          <div className="m-auto max-w-md text-center space-y-3 py-8">
            <div className="text-3xl">
              {chatMode === "talk" ? "💬" : "🛡️"}
            </div>
            <div className="text-lg font-semibold">
              {chatMode === "talk"
                ? "Architecture & Planning Mode"
                : currentFilesCount > 0
                  ? "What should we build or update?"
                  : "What do you want to build?"}
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              {chatMode === "talk"
                ? "Brainstorm architecture (with interactive Mermaid diagrams) or plan refactors safely. Your conversation & context are saved in ./.zt-storage/ for 24 hours."
                : "Nothing is applied until you approve it. Type @ in the box below to autocomplete and pin workspace files. Chats & file diffs persist on disk for 24h."}
            </p>
            <div className="flex flex-wrap justify-center gap-2 pt-1">
              {ideas.map((idea) => (
                <button
                  key={idea}
                  onClick={() => triggerSend(idea)}
                  className="text-xs px-3 py-1.5 rounded-full border border-slate-600 hover:bg-slate-800 text-slate-200"
                >
                  {idea}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, idx) => {
          const isMatched = searchQuery.trim() !== "" && matchSet.has(idx);
          if (filterOnlyMatches && searchQuery.trim() !== "" && !isMatched) {
            return null;
          }
          const isFocusedMatch = idx === focusedMsgIndex;
          const isLastModel = idx === lastModelIdx && !busy;
          const askedConfirmation =
            m.role === "model" &&
            (!m.ops || m.ops.length === 0) &&
            /confirm|proceed|shall i|would you like me to|approve this plan/i.test(
              m.text
            );

          const highlightRing = isFocusedMatch
            ? "ring-2 ring-sky-400 rounded-2xl p-1 bg-sky-950/20"
            : isMatched
              ? "ring-1 ring-sky-500/40 rounded-2xl p-1"
              : "";

          return m.role === "user" ? (
            <div
              key={idx}
              ref={(el) => {
                msgRefs.current[idx] = el;
              }}
              className={`chat-msg-row flex justify-end ${highlightRing}`}
            >
              <div className="flex flex-col items-end gap-1.5 max-w-[90%]">
                <div
                  className={`rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm text-white whitespace-pre-wrap break-words max-w-full shadow-sm ${
                    m.mode === "talk"
                      ? "bg-gradient-to-br from-indigo-600 to-indigo-700"
                      : "bg-gradient-to-br from-emerald-600 to-emerald-700"
                  }`}
                >
                  {m.text}
                </div>
                {m.attachments && m.attachments.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 justify-end">
                    {m.attachments.map((att, ai) => (
                      <div
                        key={ai}
                        className="bg-slate-900 border border-emerald-500/40 rounded-lg p-1.5 text-[11px] text-emerald-200 flex items-center gap-2"
                      >
                        {att.kind === "image" && att.url ? (
                          <a
                            href={att.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0"
                            title="Open full image in new tab"
                          >
                            <img
                              src={att.url}
                              alt={att.name}
                              className="h-10 w-10 object-cover rounded border border-slate-700"
                            />
                          </a>
                        ) : att.kind === "video" && att.url ? (
                          <video
                            src={att.url}
                            className="h-10 w-10 object-cover rounded border border-slate-700 shrink-0"
                            muted
                          />
                        ) : (
                          <span>
                            {att.kind === "image"
                              ? "🖼️"
                              : att.kind === "video"
                                ? "🎬"
                                : att.kind === "audio"
                                  ? "🎵"
                                  : att.kind === "pdf"
                                    ? "📕"
                                    : "📄"}
                          </span>
                        )}
                        <span className="truncate max-w-[160px]">
                          {att.url ? (
                            <a
                              href={att.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:underline"
                            >
                              {att.name}
                            </a>
                          ) : (
                            att.name
                          )}
                        </span>
                        <span className="text-slate-400 text-[10px]">
                          ({formatBytes(att.size)})
                        </span>
                      </div>
                    ))}
                  </div>
                ) : m.images && m.images > 0 ? (
                  <div className="text-[11px] text-slate-500">
                    📎 {m.images} attachment(s)
                  </div>
                ) : null}
                <div className="text-[11px] text-slate-500 flex items-center gap-2">
                  <span
                    className={`px-1.5 py-0.2 rounded text-[9px] font-mono uppercase ${
                      m.mode === "talk"
                        ? "bg-indigo-950 text-indigo-300 border border-indigo-700/50"
                        : "bg-emerald-950 text-emerald-300 border border-emerald-700/50"
                    }`}
                  >
                    {m.mode === "talk" ? "💬 Talk" : "🔨 Build"}
                  </span>
                  <span>
                    Turn #{Math.floor(idx / 2) + 1} · You · {timeStr(m.ts)}
                  </span>
                  {filterOnlyMatches && (
                    <button
                      onClick={() => {
                        setFilterOnlyMatches(false);
                        jumpToMessageIndex(idx);
                      }}
                      className="text-sky-400 hover:underline font-mono text-[10px]"
                    >
                      Jump to context ↵
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div
              key={idx}
              ref={(el) => {
                msgRefs.current[idx] = el;
              }}
              className={`chat-msg-row flex justify-start ${highlightRing}`}
            >
              <div className="flex flex-col items-start gap-1.5 max-w-[94%] min-w-0">
                <MarkdownContent text={m.text} onCopy={onCopy} />
                {m.ops && m.ops.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {m.ops.map(renderChip)}
                  </div>
                )}

                {isLastModel && (m.mode === "talk" || askedConfirmation) && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {m.mode === "talk" && (
                      <button
                        onClick={() => {
                          setChatMode("build");
                          triggerSend(
                            "Confirmed. Please switch to Build Mode and implement the architecture and plan we just discussed.",
                            "build"
                          );
                        }}
                        className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600/30 hover:bg-emerald-600/50 border border-emerald-500/50 text-emerald-200 font-medium flex items-center gap-1.5"
                      >
                        ⚡ Switch to Build &amp; Implement Plan
                      </button>
                    )}
                    {askedConfirmation && m.mode !== "talk" && (
                      <button
                        onClick={() =>
                          triggerSend(
                            "Confirmed! Please proceed with the architectural changes / deletions you described and propose the file updates.",
                            "build"
                          )
                        }
                        className="text-xs px-3 py-1.5 rounded-lg bg-amber-600/30 hover:bg-amber-600/50 border border-amber-500/50 text-amber-200 font-medium flex items-center gap-1.5"
                      >
                        ✅ Confirm &amp; Proceed with Changes
                      </button>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                  <span
                    className={`px-1.5 py-0.2 rounded text-[9px] font-mono uppercase ${
                      m.mode === "talk"
                        ? "bg-indigo-950 text-indigo-300 border border-indigo-700/50"
                        : "bg-emerald-950 text-emerald-300 border border-emerald-700/50"
                    }`}
                  >
                    {m.mode === "talk" ? "💬 Talk" : "🔨 Build"}
                  </span>
                  <span>
                    Turn #{Math.floor(idx / 2) + 1} · AI · {timeStr(m.ts)}
                    {m.duration ? ` · ${m.duration}s` : ""}
                  </span>
                  <button
                    onClick={() => onCopy(m.text)}
                    className="hover:text-slate-300"
                  >
                    Copy reply
                  </button>
                  {filterOnlyMatches && (
                    <button
                      onClick={() => {
                        setFilterOnlyMatches(false);
                        jumpToMessageIndex(idx);
                      }}
                      className="text-sky-400 hover:underline font-mono text-[10px]"
                    >
                      Jump to context ↵
                    </button>
                  )}
                  {isLastModel && (
                    <span className="flex gap-3">
                      <button
                        onClick={() => onRetryLast(false)}
                        className="hover:text-slate-300"
                      >
                        ↻ Retry
                      </button>
                      <button
                        onClick={() => onRetryLast(true)}
                        className="hover:text-slate-300"
                      >
                        ✎ Edit prompt
                      </button>
                    </span>
                  )}
                </div>
                {isLastModel && m.next && m.next.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {m.next.map((n, ni) => (
                      <button
                        key={ni}
                        onClick={() => triggerSend(n)}
                        className="text-[11px] px-2.5 py-1 rounded-full border border-sky-500/40 text-sky-200 hover:bg-sky-900/40 transition-colors"
                      >
                        ✨ {n}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {busy && (
          <div className="flex justify-start">
            <div className="flex flex-col items-start gap-1.5 max-w-[94%] min-w-0">
              {streamingText ? (
                <>
                  <MarkdownContent
                    text={streamingText}
                    onCopy={onCopy}
                    isStreaming
                  />
                  <div className="text-[11px] text-amber-400/90 font-mono flex items-center gap-1.5 px-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                    <StreamingTimer label="Generating response ·" />
                  </div>
                </>
              ) : (
                <div className="rounded-2xl px-4 py-3 text-sm bg-slate-900 border border-slate-800 text-slate-200 flex items-center gap-2.5 shadow-sm">
                  <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                  <span className="text-amber-300 font-mono text-xs">
                    <StreamingTimer
                      label={
                        chatMode === "talk"
                          ? "🧠 Planning architecture…"
                          : "🧠 Analyzing & building…"
                      }
                    />
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {!stickToBottom && (
        <button
          onClick={scrollDown}
          className="absolute bottom-32 right-5 bg-slate-800 border border-slate-600 text-xs px-3 py-1 rounded-full shadow-lg hover:bg-slate-700 z-10"
        >
          ↓ Latest
        </button>
      )}

      <footer className="border-t border-slate-800 bg-slate-900 p-3 space-y-2 shrink-0 relative">
        {/* @file Autocomplete Popup */}
        {mentionMatches.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 mb-1 bg-slate-900 border border-emerald-500/50 rounded-xl shadow-2xl overflow-hidden z-30">
            <div className="px-3 py-1 bg-slate-950 border-b border-slate-800 text-[10px] text-emerald-400 font-mono flex justify-between">
              <span>📌 Pin workspace file (@file autocomplete)</span>
              <span>↑/↓ + Enter or Tab</span>
            </div>
            <div className="max-h-44 overflow-y-auto">
              {mentionMatches.map((f, i) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => insertMention(f)}
                  className={`w-full text-left px-3 py-1.5 text-xs font-mono flex items-center gap-2 ${
                    i === mentionIdx
                      ? "bg-emerald-600/30 text-emerald-200"
                      : "text-slate-300 hover:bg-slate-800"
                  }`}
                >
                  <span>📄</span>
                  <span className="truncate">{f}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Mode & Critical Guardrail Controls Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setChatMode("build")}
              className={`px-2.5 py-1 rounded-md font-medium flex items-center gap-1 transition-colors ${
                chatMode === "build"
                  ? "bg-emerald-600 text-white shadow"
                  : "bg-slate-950 text-slate-400 border border-slate-800 hover:text-slate-200"
              }`}
            >
              🔨 Build Mode
            </button>
            <button
              type="button"
              onClick={() => setChatMode("talk")}
              className={`px-2.5 py-1 rounded-md font-medium flex items-center gap-1 transition-colors ${
                chatMode === "talk"
                  ? "bg-indigo-600 text-white shadow"
                  : "bg-slate-950 text-slate-400 border border-slate-800 hover:text-slate-200"
              }`}
            >
              💬 Talk / Plan Mode
            </button>
          </div>

          {chatMode === "build" ? (
            <label
              className="flex items-center gap-1.5 text-slate-300 cursor-pointer select-none"
              title="When checked, the AI will ask for confirmation in chat before deleting files or making critical architectural changes"
            >
              <input
                type="checkbox"
                checked={askBeforeCritical}
                onChange={(e) => setAskBeforeCritical(e.target.checked)}
                className="accent-amber-500"
              />
              <span>🛡️ Ask before deleting / critical changes</span>
            </label>
          ) : (
            <span className="text-indigo-300 font-mono text-[10px]">
              🔒 Safe discussion + Mermaid diagrams — file writes disabled
            </span>
          )}
        </div>

        {attachments.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>
                📎 {attachments.length} file
                {attachments.length === 1 ? "" : "s"} attached
              </span>
              <button
                type="button"
                onClick={onClearAttachments}
                className="text-rose-400 hover:underline"
              >
                Clear all
              </button>
            </div>
            <div className="flex flex-wrap gap-2 max-h-36 overflow-y-auto p-1">
              {attachments.map((a) => (
                <div
                  key={a.id}
                  className="relative group bg-slate-950 border border-slate-700 rounded-lg p-1.5 flex items-center gap-2 max-w-[220px]"
                >
                  {a.kind === "image" && a.url ? (
                    <img
                      src={a.url}
                      alt={a.name}
                      className="h-10 w-10 object-cover rounded border border-slate-700 shrink-0"
                    />
                  ) : a.kind === "video" && a.url ? (
                    <video
                      src={a.url}
                      className="h-10 w-10 object-cover rounded border border-slate-700 shrink-0"
                      muted
                    />
                  ) : (
                    <span className="text-lg px-1 shrink-0">
                      {a.kind === "audio"
                        ? "🎵"
                        : a.kind === "pdf"
                          ? "📕"
                          : a.kind === "text"
                            ? "📝"
                            : "📦"}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div
                      className="text-[11px] text-slate-200 truncate font-mono"
                      title={a.name}
                    >
                      {a.name}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {a.kind.toUpperCase()} · {formatBytes(a.size)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(a.id)}
                    className="bg-rose-600 hover:bg-rose-500 text-white rounded-full w-4 h-4 text-[10px] leading-4 text-center shrink-0"
                    title="Remove attachment"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2 items-end">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="bg-slate-800 hover:bg-slate-700 rounded-lg px-3 py-2.5 text-sm shrink-0"
            title="Attach unlimited photos, videos, audio, PDFs, or code/text files"
          >
            📎
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                onAddFiles(e.target.files);
              }
              e.target.value = "";
            }}
          />
          <textarea
            ref={textareaRef}
            rows={1}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              setMentionIdx(0);
            }}
            onPaste={(e) => {
              const pastedFiles = e.clipboardData?.files;
              if (pastedFiles && pastedFiles.length > 0) {
                e.preventDefault();
                onAddFiles(pastedFiles);
              }
            }}
            onKeyDown={(e) => {
              if (mentionMatches.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMentionIdx((i) => (i + 1) % mentionMatches.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionIdx(
                    (i) =>
                      (i - 1 + mentionMatches.length) % mentionMatches.length
                  );
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  insertMention(mentionMatches[mentionIdx] || mentionMatches[0]);
                  return;
                }
              }

              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                setHistIdx(-1);
                triggerSend();
                return;
              }
              if (
                e.key === "ArrowUp" &&
                userMessages.length > 0 &&
                (prompt === "" || histIdx >= 0) &&
                e.currentTarget.selectionStart === 0
              ) {
                e.preventDefault();
                const nextIdx = Math.min(histIdx + 1, userMessages.length - 1);
                setHistIdx(nextIdx);
                setPrompt(
                  userMessages[userMessages.length - 1 - nextIdx].text
                );
              } else if (e.key === "ArrowDown" && histIdx >= 0) {
                e.preventDefault();
                const nextIdx = histIdx - 1;
                setHistIdx(nextIdx);
                setPrompt(
                  nextIdx >= 0
                    ? userMessages[userMessages.length - 1 - nextIdx].text
                    : ""
                );
              }
            }}
            placeholder={
              chatMode === "talk"
                ? "Discuss architecture or type @ to reference a file (no files modified)…"
                : "Describe what to build or type @file to pin context…"
            }
            className={`flex-1 bg-slate-950 border rounded-lg p-2.5 text-sm focus:outline-none resize-none ${
              chatMode === "talk"
                ? "border-indigo-500/50 focus:border-indigo-400"
                : "border-slate-700 focus:border-emerald-500"
            }`}
          />
          <button
            type="button"
            onClick={() => {
              setHistIdx(-1);
              triggerSend();
            }}
            className={`${
              busy
                ? "bg-rose-600 hover:bg-rose-500"
                : chatMode === "talk"
                  ? "bg-indigo-600 hover:bg-indigo-500"
                  : "bg-emerald-600 hover:bg-emerald-500"
            } px-5 py-2.5 rounded-lg font-medium text-sm min-w-[100px] shrink-0 text-white`}
          >
            {busy ? "⏹ Stop" : chatMode === "talk" ? "💬 Ask" : "🔨 Build"}
          </button>
        </div>
        <div className="text-[10px] text-slate-500 flex justify-between">
          <span>
            Type <b>@</b> to pin files · Enter to send · ↑/↓ recalls prompt
          </span>
          <span>
            {soundOn ? "🔔 Sound Chime ON · " : "🔕 Sound Muted · "}💾 Persisted
            in ./.zt-storage/ (24h)
          </span>
        </div>
      </footer>
    </div>
  );
}