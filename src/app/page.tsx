"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import HeaderBar from "@/components/HeaderBar";
import SetupModal from "@/components/SetupModal";
import FileTreeSidebar from "@/components/FileTreeSidebar";
import ChatPane from "@/components/ChatPane";
import RightPane, { type OpenEditorTab } from "@/components/RightPane";
import ReviewModal from "@/components/ReviewModal";
import CheckpointDiffModal from "@/components/CheckpointDiffModal";
import CommandPaletteModal from "@/components/CommandPaletteModal";
import { enrichProposal, type EnrichedProposal } from "@/lib/diff";
import type {
  AttachmentPayload,
  BrowserConsoleEntry,
  ChatMode,
  CheckpointDiffFile,
  CheckpointSummary,
  CommandProposal,
  ContextInfo,
  DisplayMessage,
  FileProposal,
  OpStatus,
  SearchMatch,
  StorageStats,
  StoredSessionSummary,
  TokenUsage,
} from "@/types/builder";

interface ToastItem {
  id: number;
  msg: string;
  kind?: "err" | "ok";
}

const SESSION_STORAGE_KEY = "zt_sid_v1";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CLIENT_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB per file guard

interface StoredSessionEnvelope {
  sid: string;
  createdAt: number;
  expiresAt: number;
}

function getOrInit24hSessionId(): StoredSessionEnvelope {
  const now = Date.now();
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredSessionEnvelope;
      if (
        parsed &&
        typeof parsed.sid === "string" &&
        /^[0-9a-f-]{36}$/i.test(parsed.sid) &&
        typeof parsed.expiresAt === "number" &&
        now < parsed.expiresAt
      ) {
        return parsed;
      }
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }

  const fresh: StoredSessionEnvelope = {
    sid: crypto.randomUUID(),
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(fresh));
  } catch {
    // ignore
  }
  return fresh;
}

const TEXT_FILE_RE =
  /\.(txt|md|mdx|json|csv|tsv|js|jsx|ts|tsx|mjs|cjs|py|html|css|scss|sql|yml|yaml|toml|xml|svg|sh|bat|ps1|log|prisma|graphql|vue|svelte|astro|rs|go|java|c|cpp|h|cs|php|rb|dockerfile)$/i;

function classifyFile(
  file: File
): "image" | "video" | "audio" | "pdf" | "text" | "binary" {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type === "application/pdf") return "pdf";
  if (file.type.startsWith("text/") || TEXT_FILE_RE.test(file.name)) {
    return "text";
  }
  return "binary";
}

function cleanStreamText(t: string, tagKey: string): string {
  const k = `_${tagKey}`;
  const rx = (src: string, flags?: string) =>
    new RegExp(src.split("@@").join(k), flags);
  let out = t.replace(rx("<next@@>[\\s\\S]*?<\\/next@@>", "g"), "");
  out = out.replace(
    rx("<file@@\\s+path=[\"']([^\"']+)[\"']\\s*>[\\s\\S]*?<\\/file@@>", "g"),
    (_, p) => `\n> 📄 **File \`${p}\`** — ready for review\n`
  );
  out = out.replace(
    rx("<file@@\\s+path=[\"']([^\"']+)[\"']\\s*>[\\s\\S]*$"),
    (_, p) => `\n> ✍️ _Writing \`${p}\`…_\n`
  );
  out = out.replace(
    rx("<delete@@\\s+path=[\"']([^\"']+)[\"']\\s*(?:\\/>|>\\s*<\\/delete@@>)", "g"),
    (_, p) => `\n> 🗑️ **Delete \`${p}\`**\n`
  );
  out = out.replace(
    rx("<cmd@@>([\\s\\S]*?)<\\/cmd@@>", "g"),
    (_, c) => `\n> ⚡ **Command** \`${String(c).trim()}\`\n`
  );
  return out.replace(rx("<(file|cmd|delete|next)@@[^>]*$"), "");
}

export default function StudioPage() {
  const [sid, setSid] = useState<string>("");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const [storedSessions, setStoredSessions] = useState<StoredSessionSummary[]>(
    []
  );
  const [tagKey, setTagKey] = useState<string>("zt9f2a1b");
  const [model, setModel] = useState<string>("gemini-2.5-pro");
  const [chatMode, setChatMode] = useState<ChatMode>("build");
  const [askBeforeCritical, setAskBeforeCritical] = useState<boolean>(true);
  const [autoVerify, setAutoVerify] = useState<boolean>(false);
  const [autoHeal, setAutoHeal] = useState<boolean>(false);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState<boolean>(true);
  const [setupNote] = useState<string | undefined>(undefined);
  const [files, setFiles] = useState<string[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [ctx, setCtx] = useState<ContextInfo>({
    loaded: false,
    denied: false,
    files: 0,
    tokens: 0,
    omitted: 0,
  });
  const [turns, setTurns] = useState<number>(0);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [undoCount, setUndoCount] = useState<number>(0);

  const [pendingProps, setPendingProps] = useState<
    Record<string, EnrichedProposal>
  >({});
  const [pendingCmds, setPendingCmds] = useState<
    Record<string, CommandProposal>
  >({});

  const [reviewOpen, setReviewOpen] = useState<boolean>(false);
  const [reviewSel, setReviewSel] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);

  // Multi-Tab Docked Code Editor State
  const [openTabs, setOpenTabs] = useState<OpenEditorTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [editorFocusSeq, setEditorFocusSeq] = useState<number>(0);

  // Side-by-Side Checkpoint Diff Comparison State
  const [comparingCp, setComparingCp] = useState<CheckpointSummary | null>(
    null
  );
  const [cpDiffs, setCpDiffs] = useState<CheckpointDiffFile[]>([]);

  // Window Visibility & Layout State
  const [showExplorer, setShowExplorer] = useState<boolean>(false);
  const [showChat, setShowChat] = useState<boolean>(true);
  const [showPreview, setShowPreview] = useState<boolean>(true);
  const [showTerminal, setShowTerminal] = useState<boolean>(true);
  const [leftWidthPct, setLeftWidthPct] = useState<number>(46);
  const [isDraggingX, setIsDraggingX] = useState<boolean>(false);

  const [prompt, setPrompt] = useState<string>("");
  const [attachments, setAttachments] = useState<AttachmentPayload[]>([]);
  const [busy, setBusy] = useState<boolean>(false);
  const [streamingText, setStreamingText] = useState<string | null>(null);

  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [previewSrc, setPreviewSrc] = useState<string>("about:blank");
  const [logs, setLogs] = useState<string>("");
  const [browserLogs, setBrowserLogs] = useState<BrowserConsoleEntry[]>([]);
  const [running, setRunning] = useState<boolean>(false);
  const [autoPreviewUrl, setAutoPreviewUrl] = useState<string | null>(null);

  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const lastAutoUrlRef = useRef<string | null>(null);
  const sidRef = useRef<string>("");
  const previewUrlRef = useRef<string>("");
  const filesRef = useRef<string[]>([]);
  const openTabsRef = useRef<OpenEditorTab[]>([]);
  const tagKeyRef = useRef<string>(tagKey);
  const initializedRef = useRef<boolean>(false);
  const busyRef = useRef<boolean>(false);
  const hiddenAtRef = useRef<number | null>(null);
  const autoHealAttemptedRef = useRef<boolean>(false);

  useEffect(() => {
    sidRef.current = sid;
  }, [sid]);

  useEffect(() => {
    previewUrlRef.current = previewUrl;
  }, [previewUrl]);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    openTabsRef.current = openTabs;
  }, [openTabs]);

  useEffect(() => {
    tagKeyRef.current = tagKey;
  }, [tagKey]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // Warn before closing/reloading browser tab if any Docked Code Editor tab has unsaved changes
  useEffect(() => {
    const hasDirtyTab = openTabs.some((t) => t.content !== t.originalContent);
    if (!hasDirtyTab) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [openTabs]);

  // Global Ctrl+K / Cmd+K shortcut for Developer Command Palette
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Listen for live browser console messages from preview iframe
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data && e.data.type === "__ZT_PREVIEW_CONSOLE__") {
        setBrowserLogs((prev) => [
          ...prev.slice(-199),
          {
            id: `bc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            level: e.data.level || "log",
            text: String(e.data.text || ""),
            ts: e.data.ts || Date.now(),
          },
        ]);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const onPageHide = () => {
      if (!sidRef.current) return;
      try {
        navigator.sendBeacon(
          "/api/closing",
          new Blob([JSON.stringify({ sid: sidRef.current })], {
            type: "application/json",
          })
        );
      } catch {
        // ignore
      }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  const toast = useCallback((msg: string, kind?: "err" | "ok") => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, msg, kind }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, kind === "err" ? 6000 : 3000);
  }, []);

  const apiCall = useCallback(
    async (
      route: string,
      body?: Record<string, unknown>,
      customSid?: string
    ) => {
      const activeSid = customSid || sidRef.current;
      const res = await fetch(`/api/${route}`, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          "x-session-id": activeSid,
        },
        body: body ? JSON.stringify({ ...body, sid: activeSid }) : undefined,
      });
      const data = await res.json().catch(() => ({
        error: "Bad server response",
      }));
      if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
      return data;
    },
    []
  );

  // Sync any open non-dirty editor tabs when files are updated on disk via AI Approve, Undo, or Checkpoint Restore
  const syncOpenTabsWithDisk = useCallback(
    async (currentFileList: string[], targetPaths?: string[]) => {
      const currentTabs = openTabsRef.current;
      if (currentTabs.length === 0) return;

      const fileSet = new Set(currentFileList);
      const updatedTabs: OpenEditorTab[] = [];

      for (const tab of currentTabs) {
        if (!tab.isNew && !fileSet.has(tab.relPath)) {
          if (tab.content !== tab.originalContent) {
            updatedTabs.push(tab);
          }
          continue;
        }
        const shouldRefresh =
          !targetPaths || targetPaths.includes(tab.relPath);
        if (shouldRefresh && tab.content === tab.originalContent && !tab.isNew) {
          try {
            const res = await fetch(
              `/api/file?path=${encodeURIComponent(tab.relPath)}`,
              { headers: { "x-session-id": sidRef.current } }
            );
            const d = await res.json().catch(() => null);
            if (d && typeof d.content === "string") {
              updatedTabs.push({
                relPath: tab.relPath,
                content: d.content,
                originalContent: d.content,
                size: d.size ?? d.content.length,
              });
              continue;
            }
          } catch {
            // keep existing tab on error
          }
        }
        updatedTabs.push(tab);
      }

      setOpenTabs(updatedTabs);
      setActiveTabPath((prev) =>
        prev && updatedTabs.some((t) => t.relPath === prev)
          ? prev
          : updatedTabs[0]?.relPath || null
      );
    },
    []
  );

  const refreshSessionsList = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      const d = await res.json().catch(() => ({}));
      if (Array.isArray(d.sessions)) setStoredSessions(d.sessions);
      if (d.storage) setStorageStats(d.storage);
    } catch {
      // ignore
    }
  }, []);

  const reloadPreview = useCallback((overrideUrl?: string) => {
    const u = (overrideUrl ?? previewUrlRef.current).trim();
    if (/^https?:\/\//i.test(u) || u.startsWith("/api/preview/")) {
      setPreviewSrc(`${u}${u.includes("?") ? "&" : "?"}t=${Date.now()}`);
    }
  }, []);

  const openPreviewInNewTab = useCallback(() => {
    const u = previewUrlRef.current.trim();
    const target =
      /^https?:\/\//i.test(u) || u.startsWith("/api/preview/")
        ? u
        : `/api/preview/${sidRef.current}/index.html`;
    window.open(target, "_blank", "noopener,noreferrer");
  }, []);

  const hydrateSessionState = useCallback(
    async (
      targetSid: string,
      options?: { preservePreview?: boolean }
    ) => {
      const isSameSid = sidRef.current === targetSid;
      sidRef.current = targetSid;
      setSid(targetSid);
      const defaultPrev = `/api/preview/${targetSid}/index.html`;
      if (!options?.preservePreview || !isSameSid) {
        previewUrlRef.current = defaultPrev;
        setPreviewUrl(defaultPrev);
      }

      const d = await apiCall("state", undefined, targetSid);
      if (d.tagKey) {
        tagKeyRef.current = d.tagKey;
        setTagKey(d.tagKey);
      }
      if (d.model) setModel(d.model);
      if (d.storage) setStorageStats(d.storage);
      if (d.expiresAt) {
        setExpiresAt(d.expiresAt);
        try {
          localStorage.setItem(
            SESSION_STORAGE_KEY,
            JSON.stringify({
              sid: targetSid,
              createdAt: d.createdAt || Date.now(),
              expiresAt: d.expiresAt,
            })
          );
        } catch {
          // ignore
        }
      }
      if (d.root) {
        setWorkspace(d.root);
        setSetupOpen(false);
        setFiles(d.files || []);
        filesRef.current = d.files || [];
        setCheckpoints(d.checkpoints || []);
        const enriched: Record<string, EnrichedProposal> = {};
        (d.proposals || []).forEach((p: FileProposal) => {
          enriched[p.id] = enrichProposal(p);
        });
        setPendingProps(enriched);
        const cmds: Record<string, CommandProposal> = {};
        (d.commands || []).forEach((c: CommandProposal) => {
          cmds[c.id] = c;
        });
        setPendingCmds(cmds);
        setMessages(d.display || []);
        setLogs(d.logs || "");
        if (d.ctx) setCtx(d.ctx);
        setTurns(d.turns || 0);
        if (d.usage) setUsage(d.usage);
        setUndoCount(d.undoCount || 0);
        const pUrl = d.previewUrl || defaultPrev;
        if (!options?.preservePreview || pUrl !== previewUrlRef.current) {
          previewUrlRef.current = pUrl;
          setPreviewUrl(pUrl);
          setPreviewSrc(`${pUrl}${pUrl.includes("?") ? "&" : "?"}t=${Date.now()}`);
        }
      } else {
        setWorkspace(null);
        setSetupOpen(true);
        setFiles([]);
        filesRef.current = [];
        setCheckpoints([]);
        setPendingProps({});
        setPendingCmds({});
        setMessages([]);
        setLogs("");
        setCtx({
          loaded: false,
          denied: false,
          files: 0,
          tokens: 0,
          omitted: 0,
        });
        setTurns(0);
        setUndoCount(0);
      }
      await refreshSessionsList();
    },
    [apiCall, refreshSessionsList]
  );

  // Re-sync session from ./.zt-storage/ only when waking from a >=30s sleep/suspend,
  // preserving the preview iframe so quick Alt-Tab switching never reloads the iframe.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now();
        return;
      }
      if (
        document.visibilityState === "visible" &&
        sidRef.current &&
        !busyRef.current
      ) {
        const hiddenDuration = hiddenAtRef.current
          ? Date.now() - hiddenAtRef.current
          : 0;
        hiddenAtRef.current = null;
        if (hiddenDuration >= 30_000) {
          hydrateSessionState(sidRef.current, { preservePreview: true });
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [hydrateSessionState]);

  const updateOpStatus = useCallback((id: string, status: OpStatus) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.ops
          ? {
              ...m,
              ops: m.ops.map((o) => (o.id === id ? { ...o, status } : o)),
            }
          : m
      )
    );
  }, []);

  const fetchLogsOnce = useCallback(async () => {
    if (!sidRef.current) return false;
    try {
      const d = await apiCall("logs");
      if (d.error) return false;
      setLogs(d.logs || "");
      setRunning(!!d.running);
      setAutoPreviewUrl(d.previewUrl || null);
      if (d.previewUrl && d.previewUrl !== lastAutoUrlRef.current) {
        lastAutoUrlRef.current = d.previewUrl;
        setPreviewUrl(d.previewUrl);
        reloadPreview(d.previewUrl);
      }
      return !!d.running;
    } catch {
      return false;
    }
  }, [apiCall, reloadPreview]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    const env = getOrInit24hSessionId();
    hydrateSessionState(env.sid);
  }, [hydrateSessionState]);

  useEffect(() => {
    if (!expiresAt) return;
    const iv = setInterval(() => {
      if (Date.now() >= expiresAt) {
        try {
          localStorage.removeItem(SESSION_STORAGE_KEY);
        } catch {
          // ignore
        }
        const fresh = getOrInit24hSessionId();
        hydrateSessionState(fresh.sid);
        toast("24-hour session memory expired and was automatically cleared.");
      }
    }, 30_000);
    return () => clearInterval(iv);
  }, [expiresAt, hydrateSessionState, toast]);

  useEffect(() => {
    if (!running || !sid) return;
    const iv = setInterval(async () => {
      const stillRunning = await fetchLogsOnce();
      if (!stillRunning) {
        clearInterval(iv);
      }
    }, 1200);
    return () => clearInterval(iv);
  }, [running, sid, fetchLogsOnce]);

  const startResizeX = () => {
    setIsDraggingX(true);
    const onMove = (e: MouseEvent) => {
      const pct = (e.clientX / window.innerWidth) * 100;
      if (pct > 18 && pct < 82) setLeftWidthPct(pct);
    };
    const onUp = () => {
      setIsDraggingX(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const handleLockWorkspace = async (
    folderPath: string,
    allowCreate: boolean
  ) => {
    const d = await apiCall("lock", {
      folderPath,
      allowCreateFolder: allowCreate,
    });
    if (d.needsFolderCreationPermission) {
      if (
        confirm(
          `The folder does not exist:\n${d.resolvedPath}\n\nAllow creating it?`
        )
      ) {
        await handleLockWorkspace(folderPath, true);
      }
      return;
    }
    if (d.error) {
      toast(d.error, "err");
      return;
    }
    setWorkspace(d.workspace);
    setSetupOpen(false);
    setFiles(d.files || []);
    filesRef.current = d.files || [];
    setOpenTabs([]);
    setActiveTabPath(null);
    setCheckpoints([]);
    setMessages([]);
    setPendingProps({});
    setPendingCmds({});
    setBrowserLogs([]);
    setRunning(false);
    lastAutoUrlRef.current = null;
    setAutoPreviewUrl(null);
    setLogs(`🔒 Terminal locked to: ${d.workspace}\n`);
    setCtx({ loaded: false, denied: false, files: 0, tokens: 0, omitted: 0 });
    setTurns(0);
    setUndoCount(0);
    const defaultPrev = `/api/preview/${sidRef.current}/index.html`;
    setPreviewUrl(defaultPrev);
    reloadPreview(defaultPrev);
    await refreshSessionsList();
  };

  const handleSend = async (
    override?: string,
    overrideMode?: ChatMode,
    isAutoHealTurn = false
  ) => {
    if (busy) {
      abortRef.current?.abort();
      await apiCall("stop", {});
      return;
    }
    if (!isAutoHealTurn) {
      autoHealAttemptedRef.current = false;
    }
    const activeMode = overrideMode || chatMode;
    const text = (typeof override === "string" ? override : prompt).trim();
    if (!text && attachments.length === 0) return;
    if (!workspace) {
      setSetupOpen(true);
      return;
    }

    let allowRead = true;
    if (!ctx.loaded && files.length > 0) {
      allowRead = confirm(
        `🛡️ READ PERMISSION (asked once per session)\n\nAllow the AI to read the ${files.length} file(s) in your locked workspace? It reads them once and stores the snapshot in ./.zt-storage/ for 24 hours.\n\n(.env files and lockfiles are never read.)`
      );
    }

    const sentAttachments = [...attachments];
    if (typeof override !== "string") setPrompt("");
    setAttachments([]);

    const userMsg: DisplayMessage = {
      role: "user",
      text:
        text ||
        `Please analyze the ${sentAttachments.length} attached file(s)/media.`,
      ts: Date.now(),
      mode: activeMode,
      images: sentAttachments.length,
      attachments: sentAttachments.map((a) => ({
        id: a.id,
        name: a.name,
        mime: a.mime,
        size: a.size,
        kind: a.kind,
        url: a.url,
      })),
    };
    setMessages((prev) => [...prev, userMsg]);
    setBusy(true);
    setStreamingText("");

    const ac = new AbortController();
    abortRef.current = ac;
    let receivedDone = false;
    let rafId: number | null = null;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        signal: ac.signal,
        headers: {
          "Content-Type": "application/json",
          "x-session-id": sidRef.current,
        },
        body: JSON.stringify({
          sid: sidRef.current,
          model,
          chatMode: activeMode,
          askBeforeCritical,
          prompt: userMsg.text,
          allowRead,
          attachments: sentAttachments.map((a) => ({
            id: a.id,
            name: a.name,
            mime: a.mime,
            size: a.size,
            kind: a.kind,
            data: a.data,
            textContent: a.textContent,
          })),
        }),
      });

      if (!res.ok || !res.body) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let full = "";

      const scheduleStreamPaint = () => {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          setStreamingText(cleanStreamText(full, tagKeyRef.current));
        });
      };

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          return;
        }
        if (m.t === "meta") {
          setCtx(m.ctx);
          if (m.tagKey) {
            tagKeyRef.current = m.tagKey;
            setTagKey(m.tagKey);
          }
        } else if (m.t === "d") {
          full += m.x;
          scheduleStreamPaint();
        } else if (m.t === "error") {
          throw new Error(m.error);
        } else if (m.t === "done") {
          receivedDone = true;
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          setPendingProps((prev) => {
            const next = { ...prev };
            (m.proposals || []).forEach((p: FileProposal) => {
              next[p.id] = enrichProposal(p);
            });
            return next;
          });

          setPendingCmds((prev) => {
            const next = { ...prev };
            (m.commands || []).forEach((c: CommandProposal) => {
              next[c.id] = c;
            });
            return next;
          });

          const modelMsg: DisplayMessage = {
            role: "model",
            text: m.text,
            duration: m.duration,
            ts: m.ts,
            mode: m.mode || activeMode,
            ops: m.ops,
            next: m.next,
          };
          setMessages((prev) => {
            const updated = [...prev];
            if (
              Array.isArray(m.userAttachments) &&
              m.userAttachments.length > 0 &&
              updated.length > 0 &&
              updated[updated.length - 1].role === "user"
            ) {
              updated[updated.length - 1] = {
                ...updated[updated.length - 1],
                attachments: m.userAttachments,
              };
            }
            return [...updated, modelMsg];
          });
          if (m.ctx) setCtx(m.ctx);
          if (m.turns !== undefined) setTurns(m.turns);
          if (m.usage) setUsage(m.usage);
          if (m.storage) setStorageStats(m.storage);

          if ((m.proposals || []).length > 0) {
            setReviewSel(m.proposals[0].id);
            setReviewOpen(true);
            toast("Review the proposed changes before they are applied");
          }
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          processLine(line);
        }
      }

      if (buf.trim()) {
        processLine(buf);
      }

      if (!receivedDone && full.trim()) {
        setMessages((prev) => [
          ...prev,
          {
            role: "model",
            text: cleanStreamText(full, tagKeyRef.current),
            ts: Date.now(),
            mode: activeMode,
          },
        ]);
      }
    } catch (err: unknown) {
      if (!receivedDone) {
        setMessages((prev) => prev.slice(0, -1));
        if (typeof override !== "string" && text) {
          setPrompt((cur) => cur || text);
        }
        if (sentAttachments.length > 0) {
          setAttachments((cur) => (cur.length ? cur : sentAttachments));
        }
      }
      const msg =
        err instanceof Error
          ? err.name === "AbortError"
            ? "Stopped. That turn was not saved."
            : err.message
          : String(err);
      toast(msg, "err");
    } finally {
      if (rafId !== null) cancelAnimationFrame(rafId);
      setBusy(false);
      setStreamingText(null);
      abortRef.current = null;
    }
  };

  const handleRunManualCommand = async (cmd: string, wait = false) => {
    setShowTerminal(true);
    setRunning(true);
    const d = await apiCall("run-command", { command: cmd, wait });
    if (d.error && !d.output) {
      setRunning(false);
      toast(d.error, "err");
      return d;
    }
    await fetchLogsOnce();
    return d;
  };

  const runVerificationAndOptionalHeal = async () => {
    toast("🔄 Auto-Verify: Running npx tsc --noEmit...");
    const res = await handleRunManualCommand("npx tsc --noEmit", true);
    if (
      res &&
      typeof res.code === "number" &&
      res.code !== 0 &&
      autoHeal &&
      !autoHealAttemptedRef.current
    ) {
      autoHealAttemptedRef.current = true;
      const errOut = String(res.output || logs).slice(-3500);
      toast("🤖 Auto-Heal: Sending TypeScript errors to AI for automatic fix...");
      setShowChat(true);
      setChatMode("build");
      await handleSend(
        `Auto-Verify (\`npx tsc --noEmit\`) failed with exit code ${res.code}. Please diagnose and fix these TypeScript errors:\n\n\`\`\`\n${errOut}\n\`\`\``,
        "build",
        true
      );
    }
  };

  const handleApproveWrite = async (
    id: string,
    force = false,
    customContent?: string
  ): Promise<boolean> => {
    const prop = pendingProps[id];
    if (prop && prop.isCritical && !force) {
      const confirmed = confirm(
        `⚠️ CRITICAL ARCHITECTURE / DELETION CONFIRMATION\n\n` +
          `${prop.criticalReason || `File: ${prop.relPath}`}\n\n` +
          `Are you sure you want to ${prop.kind === "delete" ? "DELETE" : "OVERWRITE"} "${prop.relPath}"?`
      );
      if (!confirmed) return false;
    }

    const d = await apiCall("approve-write", { id, force, customContent });
    if (d.stale) {
      if (confirm(`${d.error}\n\nApply the AI's version anyway?`)) {
        return handleApproveWrite(id, true, customContent);
      }
      return false;
    }
    if (d.error) {
      toast(`Blocked: ${d.error}`, "err");
      return false;
    }
    setPendingProps((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    updateOpStatus(id, "approved");
    const updatedFiles: string[] = d.files || [];
    setFiles(updatedFiles);
    filesRef.current = updatedFiles;
    setUndoCount(d.undoCount || 0);
    if (d.storage) setStorageStats(d.storage);
    if (prop?.relPath) {
      await syncOpenTabsWithDisk(updatedFiles, [prop.relPath]);
    }
    reloadPreview();
    return true;
  };

  const handleRejectWrite = async (id: string) => {
    await apiCall("reject-write", { id });
    setPendingProps((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    updateOpStatus(id, "denied");
  };

  const handleApproveCommand = async (id: string, wait = false) => {
    setShowTerminal(true);
    setRunning(true);
    const d = await apiCall("approve-command", { id, wait });
    if (d.error) {
      setRunning(false);
      toast(d.error, "err");
      return d;
    }
    setPendingCmds((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    updateOpStatus(id, "ran");
    await fetchLogsOnce();
    return d;
  };

  const handleRejectCommand = async (id: string) => {
    await apiCall("reject-command", { id });
    setPendingCmds((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    updateOpStatus(id, "denied");
  };

  const handleApproveFiles = async (
    skipVerify = false,
    editedMap?: Record<string, string>
  ): Promise<boolean> => {
    for (const id of Object.keys(pendingProps)) {
      const custom = editedMap ? editedMap[id] : undefined;
      const ok = await handleApproveWrite(id, false, custom);
      if (!ok) return false;
    }
    if (
      autoVerify &&
      !skipVerify &&
      filesRef.current.includes("tsconfig.json")
    ) {
      await runVerificationAndOptionalHeal();
    }
    return true;
  };

  const handleApproveAll = async (editedMap?: Record<string, string>) => {
    const cmds = Object.values(pendingCmds);
    if (
      cmds.length > 0 &&
      !confirm(
        `This will write all proposed files and then run, in order:\n\n${cmds.map((c) => `• ${c.command}`).join("\n")}\n\nContinue?`
      )
    ) {
      return;
    }
    if (!(await handleApproveFiles(cmds.length > 0, editedMap))) return;
    for (const c of cmds) {
      const d = await handleApproveCommand(c.id, true);
      if (d.error || d.code) return;
    }
    if (
      autoVerify &&
      cmds.length > 0 &&
      filesRef.current.includes("tsconfig.json")
    ) {
      await runVerificationAndOptionalHeal();
    }
    setReviewOpen(false);
  };

  const handleDenyAll = async () => {
    if (!confirm("Deny every pending change and command?")) return;
    for (const id of Object.keys(pendingProps)) await handleRejectWrite(id);
    for (const id of Object.keys(pendingCmds)) await handleRejectCommand(id);
    setReviewOpen(false);
  };

  const handleRetryLast = async (editOnly: boolean) => {
    if (busy) return;
    let d = await apiCall("undo-turn", {});
    if (d.approvedOps) {
      if (
        !confirm(
          "Some changes from that reply were already applied to your files. They will NOT be reverted (use Undo for that). Retry anyway?"
        )
      ) {
        return;
      }
      d = await apiCall("undo-turn", { force: true });
    }
    if (d.error) {
      toast(d.error, "err");
      return;
    }
    (d.removedIds || []).forEach((id: string) => {
      setPendingProps((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setPendingCmds((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    });
    setMessages((prev) => prev.slice(0, -2));
    setTurns(d.turns || 0);
    if (d.storage) setStorageStats(d.storage);
    const prevMode: ChatMode = d.mode === "talk" ? "talk" : "build";
    setChatMode(prevMode);
    if (editOnly) {
      setPrompt(d.prompt || "");
    } else if (d.prompt) {
      handleSend(d.prompt, prevMode);
    }
  };

  const handleAddFiles = (fileList: FileList | File[]) => {
    const arr = Array.from(fileList);
    arr.forEach((f) => {
      if (f.size > MAX_CLIENT_ATTACHMENT_BYTES) {
        toast(
          `Skipped "${f.name}" (${(f.size / (1024 * 1024)).toFixed(1)} MB) — max attachment size is 25 MB.`,
          "err"
        );
        return;
      }
      const kind = classifyFile(f);
      const id = `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const mime = f.type || "application/octet-stream";

      if (kind === "text") {
        const reader = new FileReader();
        reader.onerror = () => toast(`Failed to read ${f.name}`, "err");
        reader.onload = () => {
          setAttachments((prev) => [
            ...prev,
            {
              id,
              name: f.name,
              mime,
              size: f.size,
              kind,
              textContent: String(reader.result || ""),
            },
          ]);
        };
        reader.readAsText(f);
      } else {
        const reader = new FileReader();
        reader.onerror = () => toast(`Failed to read ${f.name}`, "err");
        reader.onload = () => {
          const dataUrl = String(reader.result || "");
          const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : "";
          setAttachments((prev) => [
            ...prev,
            {
              id,
              name: f.name,
              mime,
              size: f.size,
              kind,
              data: base64,
              url: dataUrl,
            },
          ]);
        };
        reader.readAsDataURL(f);
      }
    });
  };

  const handleInspectFile = async (relPath: string) => {
    setShowPreview(true);
    setEditorFocusSeq((n) => n + 1);
    const existing = openTabs.find((t) => t.relPath === relPath);
    if (existing) {
      setActiveTabPath(relPath);
      return;
    }
    const res = await fetch(
      `/api/file?path=${encodeURIComponent(relPath)}`,
      {
        headers: { "x-session-id": sidRef.current },
      }
    );
    const d = await res.json().catch(() => ({ error: "Failed to read file" }));
    if (d.error) {
      toast(d.error, "err");
      return;
    }
    const newTab: OpenEditorTab = {
      relPath: d.relPath,
      content: d.content,
      originalContent: d.content,
      size: d.size,
    };
    setOpenTabs((prev) => [...prev, newTab]);
    setActiveTabPath(d.relPath);
  };

  const handleUpdateTabContent = (relPath: string, nextContent: string) => {
    setOpenTabs((prev) =>
      prev.map((t) =>
        t.relPath === relPath ? { ...t, content: nextContent } : t
      )
    );
  };

  const handleSaveTab = async (relPath: string) => {
    const tab = openTabs.find((t) => t.relPath === relPath);
    if (!tab) return;
    const res = await fetch("/api/file", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-session-id": sidRef.current,
      },
      body: JSON.stringify({
        sid: sidRef.current,
        relPath: tab.relPath,
        content: tab.content,
      }),
    });
    const d = await res.json().catch(() => ({ error: "Save failed" }));
    if (d.error) {
      toast(d.error, "err");
      return;
    }
    setOpenTabs((prev) =>
      prev.map((t) =>
        t.relPath === relPath
          ? { ...t, originalContent: t.content, isNew: false }
          : t
      )
    );
    const nextFiles = d.files || files;
    setFiles(nextFiles);
    filesRef.current = nextFiles;
    setUndoCount(d.undoCount ?? undoCount);
    if (d.storage) setStorageStats(d.storage);
    reloadPreview();
    toast(`Saved ${tab.relPath}`);
  };

  const handleDeleteTabFile = async (relPath: string) => {
    const tab = openTabs.find((t) => t.relPath === relPath);
    if (!tab || tab.isNew) return;
    if (!confirm(`Delete ${relPath} from workspace disk?`)) return;

    const res = await fetch("/api/file", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "x-session-id": sidRef.current,
      },
      body: JSON.stringify({
        sid: sidRef.current,
        relPath,
      }),
    });
    const d = await res.json().catch(() => ({ error: "Delete failed" }));
    if (d.error) {
      toast(d.error, "err");
      return;
    }
    const nextFiles = d.files || files;
    setFiles(nextFiles);
    filesRef.current = nextFiles;
    setUndoCount(d.undoCount ?? undoCount);
    if (d.storage) setStorageStats(d.storage);
    setOpenTabs((prev) => {
      const next = prev.filter((t) => t.relPath !== relPath);
      if (activeTabPath === relPath) {
        setActiveTabPath(next.length > 0 ? next[next.length - 1].relPath : null);
      }
      return next;
    });
    reloadPreview();
    toast(`Deleted ${relPath} (Undo available)`);
  };

  const handleCloseTab = (relPath: string) => {
    const tab = openTabs.find((t) => t.relPath === relPath);
    if (
      tab &&
      tab.content !== tab.originalContent &&
      !confirm(`Discard unsaved changes in ${relPath}?`)
    ) {
      return;
    }
    setOpenTabs((prev) => {
      const next = prev.filter((t) => t.relPath !== relPath);
      if (activeTabPath === relPath) {
        setActiveTabPath(next.length > 0 ? next[next.length - 1].relPath : null);
      }
      return next;
    });
  };

  const handleSearchWorkspace = async (query: string): Promise<SearchMatch[]> => {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
      headers: { "x-session-id": sidRef.current },
    });
    const d = await res.json().catch(() => ({ matches: [] }));
    return d.matches || [];
  };

  const handleCreateNewFile = () => {
    const relPath = window.prompt(
      "Enter relative file path to create (e.g. src/utils/helper.ts):"
    );
    if (!relPath || !relPath.trim()) return;
    const clean = relPath.trim();
    setShowPreview(true);
    setEditorFocusSeq((n) => n + 1);
    setOpenTabs((prev) => {
      if (prev.some((t) => t.relPath === clean)) return prev;
      return [
        ...prev,
        {
          relPath: clean,
          content: "",
          originalContent: "",
          size: 0,
          isNew: true,
        },
      ];
    });
    setActiveTabPath(clean);
  };

  const handleRestoreCheckpoint = async (id: string, name: string) => {
    const d = await apiCall("checkpoints", { action: "restore", id });
    if (d.error) {
      toast(d.error, "err");
      return;
    }
    const nextFiles: string[] = d.files || [];
    setFiles(nextFiles);
    filesRef.current = nextFiles;
    if (d.undoCount !== undefined) setUndoCount(d.undoCount);
    setPendingProps({});
    setMessages((prev) =>
      prev.map((m) =>
        m.ops
          ? {
              ...m,
              ops: m.ops.map((o) =>
                o.kind !== "cmd" && o.status === "pending"
                  ? { ...o, status: "superseded" as const }
                  : o
              ),
            }
          : m
      )
    );
    if (d.ctx) setCtx(d.ctx);
    if (d.storage) setStorageStats(d.storage);
    await syncOpenTabsWithDisk(nextFiles);
    reloadPreview();
    toast(`Restored workspace to "${d.restored || name}" (Undo available)`);
  };

  const handleUndo = useCallback(async () => {
    const d = await apiCall("undo", {});
    if (d.error) return toast(d.error, "err");
    const nextFiles: string[] = d.files || [];
    setFiles(nextFiles);
    filesRef.current = nextFiles;
    setUndoCount(d.undoCount || 0);
    if (d.storage) setStorageStats(d.storage);
    const undoneIdsSet = new Set<string>(d.undoneIds || []);
    const undoneFilesList: string[] = Array.isArray(d.undoneFiles)
      ? d.undoneFiles
      : d.undone
        ? [d.undone]
        : [];
    const remainingRels = new Set<string>(undoneFilesList);

    setMessages((prev) => {
      const copy = prev.map((m) => ({
        ...m,
        ops: m.ops ? m.ops.map((o) => ({ ...o })) : undefined,
      }));
      for (let i = copy.length - 1; i >= 0; i--) {
        const ops = copy[i].ops || [];
        for (let j = ops.length - 1; j >= 0; j--) {
          const op = ops[j];
          if (op.status !== "approved") continue;
          if (undoneIdsSet.has(op.id)) {
            op.status = "undone";
          } else if (
            undoneIdsSet.size === 0 &&
            op.relPath &&
            remainingRels.has(op.relPath)
          ) {
            op.status = "undone";
            remainingRels.delete(op.relPath);
          }
        }
      }
      return copy;
    });

    await syncOpenTabsWithDisk(nextFiles, undoneFilesList);
    reloadPreview();
    if (undoneFilesList.length > 1) {
      toast(
        `Reverted ${undoneFilesList.length} files${d.turn && d.turn > 0 ? ` from Turn #${d.turn}` : ""}: ${undoneFilesList.join(", ")}`
      );
    } else {
      toast(`Reverted ${undoneFilesList[0] || d.undone}`);
    }
  }, [apiCall, reloadPreview, syncOpenTabsWithDisk, toast]);

  const rightColumnVisible = showPreview || showTerminal;

  return (
    <>
      <div className="fixed bottom-4 right-4 z-[70] flex flex-col gap-2 items-end">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`px-3 py-2 rounded-lg text-xs shadow-lg border max-w-sm ${
              t.kind === "err"
                ? "bg-rose-950 border-rose-500/50 text-rose-200"
                : "bg-slate-800 border-slate-600 text-slate-100"
            }`}
          >
            {t.msg}
          </div>
        ))}
      </div>

      <CommandPaletteModal
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        files={files}
        chatMode={chatMode}
        setChatMode={setChatMode}
        onSelectFile={handleInspectFile}
        onPinFile={(relPath) => {
          setShowChat(true);
          setPrompt((prev) => (prev ? `${prev} @${relPath} ` : `@${relPath} `));
          toast(`Pinned @${relPath} to chat`);
        }}
        onRunCommand={(cmd) => {
          handleRunManualCommand(cmd);
        }}
        onCreateCheckpoint={async () => {
          const name =
            window.prompt("Checkpoint name:") ||
            `Checkpoint #${checkpoints.length + 1}`;
          if (!name.trim()) return;
          const d = await apiCall("checkpoints", {
            action: "create",
            name: name.trim(),
          });
          if (d.error) return toast(d.error, "err");
          setCheckpoints(d.checkpoints || []);
          if (d.storage) setStorageStats(d.storage);
          toast(`Saved deduplicated checkpoint "${name}"`);
        }}
        onOpenSetup={() => setSetupOpen(true)}
        onRefreshContext={async () => {
          const d = await apiCall("refresh-context", { allowRead: true });
          if (d.error) return toast(d.error, "err");
          setCtx(d.ctx);
          if (d.storage) setStorageStats(d.storage);
          toast("Project re-read");
        }}
        onUndo={handleUndo}
        onClearStorage={async () => {
          if (
            !confirm(
              "🧹 Clear all .zt-storage/ disk storage (all cached blobs, saved sessions, and checkpoints)?"
            )
          ) {
            return;
          }
          const prevWorkspace = workspace;
          await fetch("/api/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "clear-all" }),
          });
          localStorage.removeItem(SESSION_STORAGE_KEY);
          const fresh = getOrInit24hSessionId();
          await hydrateSessionState(fresh.sid);
          if (prevWorkspace) await handleLockWorkspace(prevWorkspace, false);
          toast("Storage cleared");
        }}
        onToggleExplorer={() => setShowExplorer((v) => !v)}
        onToggleChat={() => setShowChat((v) => !v)}
        onTogglePreview={() => setShowPreview((v) => !v)}
        onToggleTerminal={() => setShowTerminal((v) => !v)}
      />

      <SetupModal
        open={setupOpen}
        note={setupNote}
        canClose={!!workspace}
        onClose={() => setSetupOpen(false)}
        onLock={handleLockWorkspace}
      />

      <ReviewModal
        open={reviewOpen}
        selectedId={reviewSel}
        setSelectedId={setReviewSel}
        proposals={pendingProps}
        commands={pendingCmds}
        onClose={() => setReviewOpen(false)}
        onApproveWrite={handleApproveWrite}
        onRejectWrite={handleRejectWrite}
        onApproveCommand={handleApproveCommand}
        onRejectCommand={handleRejectCommand}
        onApproveFiles={(editedMap) => handleApproveFiles(false, editedMap)}
        onApproveAll={(editedMap) => handleApproveAll(editedMap)}
        onDenyAll={handleDenyAll}
      />

      <CheckpointDiffModal
        open={!!comparingCp}
        checkpoint={comparingCp}
        diffs={cpDiffs}
        onClose={() => {
          setComparingCp(null);
          setCpDiffs([]);
        }}
        onConfirmRestore={handleRestoreCheckpoint}
      />

      <HeaderBar
        sid={sid}
        workspace={workspace}
        ctx={ctx}
        turns={turns}
        usage={usage}
        undoCount={undoCount}
        expiresAt={expiresAt}
        storageStats={storageStats}
        storedSessions={storedSessions}
        onRefreshSessions={refreshSessionsList}
        onRunGarbageCollection={async () => {
          const res = await fetch("/api/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "gc" }),
          });
          const d = await res.json().catch(() => ({}));
          if (Array.isArray(d.sessions)) setStoredSessions(d.sessions);
          if (d.storage) setStorageStats(d.storage);
          const kb = ((d.freedBytes || 0) / 1024).toFixed(1);
          toast(
            `🧹 Blob GC complete: swept ${d.removedBlobs || 0} orphan blob(s) and ${d.purgedSessions || 0} expired session(s) (${kb} KB freed)`
          );
        }}
        onClearAllStorage={async () => {
          if (
            !confirm(
              "🧹 Clear all .zt-storage/ disk storage (all cached blobs, saved sessions, and checkpoints)?\n\nYour actual workspace project files will NOT be touched."
            )
          ) {
            return;
          }
          const prevWorkspace = workspace;
          const res = await fetch("/api/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "clear-all" }),
          });
          const d = await res.json().catch(() => ({}));
          try {
            localStorage.removeItem(SESSION_STORAGE_KEY);
          } catch {
            // ignore
          }
          const fresh = getOrInit24hSessionId();
          await hydrateSessionState(fresh.sid);
          if (prevWorkspace) {
            await handleLockWorkspace(prevWorkspace, false);
          }
          const kb = ((d.freedBytes || 0) / 1024).toFixed(1);
          toast(
            `🧹 Storage cleared: removed ${d.clearedSessions || 0} session(s) and ${d.removedBlobs || 0} blob(s) (${kb} KB freed)`
          );
        }}
        onSwitchSession={async (targetSid) => {
          await hydrateSessionState(targetSid);
          toast(`Reloaded session ${targetSid.slice(0, 8)} from disk`);
        }}
        onRenameSession={async (targetSid, newTitle) => {
          const res = await fetch("/api/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "rename",
              targetSid,
              title: newTitle,
            }),
          });
          const d = await res.json().catch(() => ({}));
          if (d.error) {
            toast(d.error, "err");
            return;
          }
          if (Array.isArray(d.sessions)) setStoredSessions(d.sessions);
          if (d.storage) setStorageStats(d.storage);
          toast("Session renamed");
        }}
        onCreateNewSession={async () => {
          const prevWorkspace = workspace;
          const now = Date.now();
          const newSid = crypto.randomUUID();
          try {
            localStorage.setItem(
              SESSION_STORAGE_KEY,
              JSON.stringify({
                sid: newSid,
                createdAt: now,
                expiresAt: now + SESSION_TTL_MS,
              })
            );
          } catch {
            // ignore
          }
          await hydrateSessionState(newSid);
          if (prevWorkspace) {
            await handleLockWorkspace(prevWorkspace, false);
          }
          toast("Started a fresh 24h session");
        }}
        onDeleteSession={async (targetSid) => {
          if (!confirm("Delete this saved session from ./.zt-storage/?")) return;
          const res = await fetch("/api/sessions", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ targetSid }),
          });
          const d = await res.json().catch(() => ({}));
          if (Array.isArray(d.sessions)) setStoredSessions(d.sessions);
          if (d.storage) setStorageStats(d.storage);
          if (targetSid === sidRef.current) {
            try {
              localStorage.removeItem(SESSION_STORAGE_KEY);
            } catch {
              // ignore
            }
            const fresh = getOrInit24hSessionId();
            await hydrateSessionState(fresh.sid);
          }
          toast("Deleted session from disk");
        }}
        model={model}
        setModel={setModel}
        previewUrl={previewUrl}
        setPreviewUrl={setPreviewUrl}
        showExplorer={showExplorer}
        setShowExplorer={setShowExplorer}
        showChat={showChat}
        setShowChat={setShowChat}
        showPreview={showPreview}
        setShowPreview={setShowPreview}
        showTerminal={showTerminal}
        setShowTerminal={setShowTerminal}
        checkpoints={checkpoints}
        onCreateCheckpoint={async (name) => {
          const d = await apiCall("checkpoints", { action: "create", name });
          if (d.error) return toast(d.error, "err");
          setCheckpoints(d.checkpoints || []);
          if (d.storage) setStorageStats(d.storage);
          toast(`Saved deduplicated checkpoint "${name}"`);
        }}
        onCompareCheckpoint={async (cp) => {
          const d = await apiCall("checkpoints", {
            action: "diff",
            id: cp.id,
          });
          if (d.error) return toast(d.error, "err");
          setCpDiffs(d.diffs || []);
          setComparingCp(cp);
        }}
        onRestoreCheckpoint={async (id, name) => {
          if (
            !confirm(
              `Restore workspace to checkpoint "${name}"? Current unsaved changes since then will be overwritten (you can Undo this restore).`
            )
          ) {
            return;
          }
          await handleRestoreCheckpoint(id, name);
        }}
        onOpenSetup={() => setSetupOpen(true)}
        onRefreshContext={async () => {
          if (!workspace) return;
          if (
            !confirm(
              "Re-read the whole project from disk and replace the cached snapshot?"
            )
          ) {
            return;
          }
          const d = await apiCall("refresh-context", { allowRead: true });
          if (d.error) return toast(d.error, "err");
          setCtx(d.ctx);
          if (d.storage) setStorageStats(d.storage);
          toast("Project re-read");
        }}
        onNewChat={async () => {
          if (
            !confirm(
              "Clear the chat, pending proposals, and reset the 24-hour memory timer? (Files on disk stay as they are.)"
            )
          ) {
            return;
          }
          const d = await apiCall("reset", {});
          setMessages([]);
          setPendingProps({});
          setPendingCmds({});
          setReviewOpen(false);
          if (d.ctx) setCtx(d.ctx);
          if (d.storage) setStorageStats(d.storage);
          if (d.expiresAt) {
            setExpiresAt(d.expiresAt);
            try {
              localStorage.setItem(
                SESSION_STORAGE_KEY,
                JSON.stringify({
                  sid: sidRef.current,
                  createdAt: d.createdAt || Date.now(),
                  expiresAt: d.expiresAt,
                })
              );
            } catch {
              // ignore
            }
          }
          setTurns(0);
          await refreshSessionsList();
        }}
        onExportChat={() => {
          if (!messages.length) return toast("Nothing to export yet.");
          const md = messages
            .map(
              (m) => `### ${m.role === "user" ? "You" : "AI"}\n\n${m.text}`
            )
            .join("\n\n---\n\n");
          const a = document.createElement("a");
          a.href = URL.createObjectURL(
            new Blob([md], { type: "text/markdown" })
          );
          a.download = `chat-${new Date().toISOString().slice(0, 10)}.md`;
          a.click();
        }}
        onUndo={handleUndo}
        onReloadPreview={() => reloadPreview()}
        onOpenPreviewInNewTab={openPreviewInNewTab}
        onOpenCommandPalette={() => setPaletteOpen(true)}
        onAskAiCommitMessage={(diffSummary) => {
          setShowChat(true);
          setChatMode("build");
          handleSend(
            `Please review my current uncommitted Git changes below, write a clear Conventional Commit message, and propose the \`git add -A && git commit -m "..."\` command for me to approve:\n\n\`\`\`\n${diffSummary}\n\`\`\``,
            "build"
          );
        }}
      />

      <div className="flex-1 flex overflow-hidden">
        {showExplorer && (
          <FileTreeSidebar
            files={files}
            onSelectFile={handleInspectFile}
            onPinFile={(relPath) => {
              setShowChat(true);
              setPrompt((prev) =>
                prev ? `${prev} @${relPath} ` : `@${relPath} `
              );
              toast(`Pinned @${relPath} to chat`);
            }}
            onCreateNewFile={handleCreateNewFile}
            onSearchFiles={handleSearchWorkspace}
            onClose={() => setShowExplorer(false)}
          />
        )}

        {showChat && (
          <ChatPane
            widthPct={leftWidthPct}
            isFullWidth={!rightColumnVisible}
            chatMode={chatMode}
            setChatMode={setChatMode}
            askBeforeCritical={askBeforeCritical}
            setAskBeforeCritical={setAskBeforeCritical}
            files={files}
            messages={messages}
            streamingText={streamingText}
            busy={busy}
            prompt={prompt}
            setPrompt={setPrompt}
            attachments={attachments}
            onAddFiles={handleAddFiles}
            onRemoveAttachment={(id) =>
              setAttachments((prev) => prev.filter((a) => a.id !== id))
            }
            onClearAttachments={() => setAttachments([])}
            onSend={handleSend}
            onRetryLast={handleRetryLast}
            onCopy={(text) => {
              navigator.clipboard?.writeText(text);
              toast("Copied to clipboard");
            }}
            onOpenReview={(id) => {
              setReviewSel(id);
              setReviewOpen(true);
            }}
            onCloseChat={
              rightColumnVisible ? () => setShowChat(false) : undefined
            }
            pendingProps={pendingProps}
            currentFilesCount={files.length}
          />
        )}

        {showChat && rightColumnVisible && (
          <div
            onMouseDown={startResizeX}
            className={`resizer-x shrink-0 ${isDraggingX ? "active" : ""}`}
            title="Drag to resize Chat and Workspace columns"
          />
        )}

        {rightColumnVisible && (
          <RightPane
            files={files}
            proposals={pendingProps}
            commands={pendingCmds}
            previewSrc={previewSrc}
            logs={logs}
            browserLogs={browserLogs}
            onClearBrowserLogs={() => setBrowserLogs([])}
            onFixBrowserErrors={() => {
              const errs = browserLogs
                .filter((b) => b.level === "error" || b.level === "warn")
                .slice(-20)
                .map((b) => `[${b.level.toUpperCase()}] ${b.text}`)
                .join("\n");
              if (!errs.trim()) {
                return toast("No browser errors captured yet.", "err");
              }
              setShowChat(true);
              setChatMode("build");
              handleSend(
                `The live preview browser console reported runtime errors. Please diagnose and fix them:\n\n${errs}`,
                "build"
              );
            }}
            running={running}
            autoPreviewUrl={autoPreviewUrl}
            autoVerify={autoVerify}
            setAutoVerify={setAutoVerify}
            autoHeal={autoHeal}
            setAutoHeal={setAutoHeal}
            showPreview={showPreview}
            setShowPreview={setShowPreview}
            showTerminal={showTerminal}
            setShowTerminal={setShowTerminal}
            isDraggingGlobal={isDraggingX}
            openTabs={openTabs}
            activeTabPath={activeTabPath}
            editorFocusSeq={editorFocusSeq}
            setActiveTabPath={setActiveTabPath}
            onUpdateTabContent={handleUpdateTabContent}
            onSaveTab={handleSaveTab}
            onDeleteTabFile={handleDeleteTabFile}
            onCloseTab={handleCloseTab}
            onPinFileToChat={(relPath) => {
              setShowChat(true);
              setPrompt((prev) =>
                prev
                  ? `${prev} @${relPath} `
                  : `In @${relPath}, please `
              );
              toast(`Pinned @${relPath} to prompt`);
            }}
            onOpenReview={(id) => {
              if (id) setReviewSel(id);
              setReviewOpen(true);
            }}
            onApproveWrite={handleApproveWrite}
            onRejectWrite={handleRejectWrite}
            onApproveCommand={handleApproveCommand}
            onRejectCommand={handleRejectCommand}
            onApproveAll={() => handleApproveAll()}
            onRunManualCommand={handleRunManualCommand}
            onFixErrors={() => {
              const tail = logs.slice(-3500);
              if (!tail.trim()) return toast("The terminal is empty.", "err");
              setShowChat(true);
              setChatMode("build");
              handleSend(
                `The terminal shows problems. Diagnose and fix them. Latest terminal output:\n\n${tail}`,
                "build"
              );
            }}
            onStopProcess={async () => {
              await apiCall("stop-process", {});
              await fetchLogsOnce();
            }}
            onRefreshLogs={() => {
              fetchLogsOnce();
              toast("Terminal logs refreshed");
            }}
            onClearLogs={async () => {
              setLogs("");
              await fetch("/api/logs", {
                method: "DELETE",
                headers: {
                  "Content-Type": "application/json",
                  "x-session-id": sidRef.current,
                },
                body: JSON.stringify({ sid: sidRef.current }),
              }).catch(() => {});
            }}
            onCopyLogs={() => {
              navigator.clipboard?.writeText(logs);
              toast("Terminal logs copied");
            }}
            onInspectFile={handleInspectFile}
            onCreateNewFile={handleCreateNewFile}
            onReloadPreview={() => reloadPreview()}
            onOpenPreviewInNewTab={openPreviewInNewTab}
          />
        )}

        {!showChat && !rightColumnVisible && (
          <div className="m-auto text-center space-y-3">
            <div className="text-slate-400 text-sm">
              All windows are currently hidden.
            </div>
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => setShowChat(true)}
                className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-3 py-1.5 rounded"
              >
                Open Chat
              </button>
              <button
                onClick={() => setShowPreview(true)}
                className="bg-blue-600 hover:bg-blue-500 text-white text-xs px-3 py-1.5 rounded"
              >
                Open Preview
              </button>
              <button
                onClick={() => setShowTerminal(true)}
                className="bg-amber-600 hover:bg-amber-500 text-white text-xs px-3 py-1.5 rounded"
              >
                Open Terminal
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}