"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  isSoundEnabled,
  onNotificationPrefChange,
  playCompletionSound,
  requestDesktopNotificationPermission,
  setSoundEnabled,
  unlockAudioContext,
} from "@/lib/notifications";
import type {
  CheckpointSummary,
  ContextInfo,
  StorageStats,
  StoredSessionSummary,
  TokenUsage,
} from "@/types/builder";

interface GitChangeItem {
  status: string;
  path: string;
}

interface GitRepoInfo {
  isRepo: boolean;
  branch: string | null;
  branches: string[];
  changes: GitChangeItem[];
}

interface AuthHealthInfo {
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

interface HeaderBarProps {
  sid: string;
  workspace: string | null;
  ctx: ContextInfo;
  turns: number;
  usage: TokenUsage | null;
  undoCount: number;
  expiresAt: number | null;
  storageStats: StorageStats | null;
  storedSessions: StoredSessionSummary[];
  onRefreshSessions: () => Promise<void>;
  onRunGarbageCollection: () => Promise<void>;
  onClearAllStorage: () => Promise<void>;
  onSwitchSession: (targetSid: string) => Promise<void>;
  onRenameSession: (targetSid: string, newTitle: string) => Promise<void>;
  onCreateNewSession: () => Promise<void>;
  onDeleteSession: (targetSid: string) => Promise<void>;
  model: string;
  setModel: (m: string) => void;
  previewUrl: string;
  setPreviewUrl: (url: string) => void;
  showExplorer: boolean;
  setShowExplorer: (v: boolean) => void;
  showChat: boolean;
  setShowChat: (v: boolean) => void;
  showPreview: boolean;
  setShowPreview: (v: boolean) => void;
  showTerminal: boolean;
  setShowTerminal: (v: boolean) => void;
  checkpoints: CheckpointSummary[];
  onCreateCheckpoint: (name: string) => Promise<void>;
  onCompareCheckpoint: (cp: CheckpointSummary) => Promise<void>;
  onRestoreCheckpoint: (id: string, name: string) => Promise<void>;
  onOpenSetup: () => void;
  onRefreshContext: () => void;
  onNewChat: () => void;
  onExportChat: () => void;
  onUndo: () => void;
  onReloadPreview: () => void;
  onOpenPreviewInNewTab: () => void;
  onOpenCommandPalette: () => void;
  onAskAiCommitMessage: (diffInfo: string) => void;
}

const fmt = (n: number) =>
  n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);

const fmtBytes = (b: number) => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
};

const MODEL_OPTIONS = [
  "gemini-4-argon",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
];

function formatRemainingTTL(expiresAt: number | null): string {
  if (!expiresAt) return "24h";
  const diff = Math.max(0, expiresAt - Date.now());
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours <= 0 && mins <= 0) return "<1m";
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export default function HeaderBar({
  sid,
  workspace,
  ctx,
  turns,
  usage,
  undoCount,
  expiresAt,
  storageStats,
  storedSessions,
  onRefreshSessions,
  onRunGarbageCollection,
  onClearAllStorage,
  onSwitchSession,
  onRenameSession,
  onCreateNewSession,
  onDeleteSession,
  model,
  setModel,
  previewUrl,
  setPreviewUrl,
  showExplorer,
  setShowExplorer,
  showChat,
  setShowChat,
  showPreview,
  setShowPreview,
  showTerminal,
  setShowTerminal,
  checkpoints,
  onCreateCheckpoint,
  onCompareCheckpoint,
  onRestoreCheckpoint,
  onOpenSetup,
  onRefreshContext,
  onNewChat,
  onExportChat,
  onUndo,
  onReloadPreview,
  onOpenPreviewInNewTab,
  onOpenCommandPalette,
  onAskAiCommitMessage,
}: HeaderBarProps) {
  const [cpOpen, setCpOpen] = useState(false);
  const [sessOpen, setSessOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authInfo, setAuthInfo] = useState<AuthHealthInfo | null>(null);
  const [authChecking, setAuthChecking] = useState(false);
  const [gitInfo, setGitInfo] = useState<GitRepoInfo>({
    isRepo: false,
    branch: null,
    branches: [],
    changes: [],
  });
  const [commitMsg, setCommitMsg] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  const [gitBusy, setGitBusy] = useState(false);
  const [gitFeedback, setGitFeedback] = useState<string | null>(null);
  const [editingSid, setEditingSid] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>("");
  const [gcRunning, setGcRunning] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);
  const [soundOn, setSoundOn] = useState<boolean>(true);
  const [ttlLabel, setTtlLabel] = useState<string>(() =>
    formatRemainingTTL(expiresAt)
  );

  useEffect(() => {
    setSoundOn(isSoundEnabled());
    return onNotificationPrefChange(() => {
      setSoundOn(isSoundEnabled());
    });
  }, []);

  const fetchAuthStatus = useCallback(
    async (reloadEnv = false) => {
      if (!sid) return;
      setAuthChecking(true);
      try {
        const res = await fetch(
          `/api/auth-status${reloadEnv ? "?reload=1" : ""}`,
          {
            headers: { "x-session-id": sid },
          }
        );
        const d = await res.json().catch(() => null);
        if (d && typeof d.configured === "boolean") {
          setAuthInfo(d as AuthHealthInfo);
        }
      } catch {
        // ignore
      } finally {
        setAuthChecking(false);
      }
    },
    [sid]
  );

  useEffect(() => {
    fetchAuthStatus(false);
  }, [fetchAuthStatus, workspace]);

  const fetchGitStatus = useCallback(async () => {
    if (!sid || !workspace) return;
    try {
      const res = await fetch("/api/git", {
        headers: { "x-session-id": sid },
      });
      const d = await res.json().catch(() => null);
      if (d && typeof d.isRepo === "boolean") {
        setGitInfo({
          isRepo: d.isRepo,
          branch: d.branch || null,
          branches: Array.isArray(d.branches) ? d.branches : [],
          changes: Array.isArray(d.changes) ? d.changes : [],
        });
      }
    } catch {
      // ignore
    }
  }, [sid, workspace]);

  useEffect(() => {
    fetchGitStatus();
  }, [fetchGitStatus, turns, undoCount]);

  useEffect(() => {
    setTtlLabel(formatRemainingTTL(expiresAt));
    const iv = setInterval(() => {
      setTtlLabel(formatRemainingTTL(expiresAt));
    }, 30_000);
    return () => clearInterval(iv);
  }, [expiresAt]);

  const ctxLabel = ctx.denied
    ? "📚 read denied"
    : ctx.loaded
      ? `📚 ${ctx.files} files · ~${fmt(ctx.tokens)} tok${ctx.omitted ? ` (+${ctx.omitted} omitted)` : ""}`
      : "📚 not read yet";

  let turnsLabel = `🧠 ${turns} turns`;
  if (usage && usage.last) {
    turnsLabel += ` · in ${fmt(usage.last.prompt)}${usage.last.cached ? ` (⚡${fmt(usage.last.cached)})` : ""} / out ${fmt(usage.last.output)}`;
  }

  const modelsList = MODEL_OPTIONS.includes(model)
    ? MODEL_OPTIONS
    : [model, ...MODEL_OPTIONS];

  return (
    <header className="border-b border-slate-800 bg-slate-900 px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0 relative">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-bold text-sm text-emerald-400 mr-1">
          🛡️ Zero-Trust Studio
        </span>
        <span
          className="bg-slate-950 border border-emerald-500/40 text-emerald-300 px-2 py-1 rounded font-mono max-w-[180px] truncate"
          title={workspace || "Not locked"}
        >
          {workspace ? `🔒 ${workspace}` : "Not locked"}
        </span>
        <button
          onClick={onOpenSetup}
          className="bg-slate-800 hover:bg-slate-700 px-2 py-1 rounded text-slate-300"
        >
          Folder
        </button>

        {/* Interactive Git Integration Panel */}
        {workspace && (
          <div className="relative">
            <button
              onClick={async () => {
                const next = !gitOpen;
                setGitOpen(next);
                setSessOpen(false);
                setCpOpen(false);
                setAuthOpen(false);
                setGitFeedback(null);
                if (next) await fetchGitStatus();
              }}
              className="bg-slate-950 hover:bg-slate-800 border border-slate-700 px-2 py-1 rounded text-teal-300 font-mono flex items-center gap-1"
              title="Git Status, Branch Switcher & Commit Panel"
            >
              <span>🌿</span>
              <span>{gitInfo.isRepo ? gitInfo.branch || "HEAD" : "git"}</span>
              {gitInfo.isRepo && gitInfo.changes.length > 0 && (
                <span className="bg-amber-500/30 text-amber-200 px-1 rounded text-[10px]">
                  {gitInfo.changes.length}
                </span>
              )}
            </button>

            {gitOpen && (
              <div className="absolute left-0 mt-1 w-80 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-3 z-50 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-xs text-teal-300">
                    🌿 Git Source Control
                  </span>
                  <button
                    onClick={() => setGitOpen(false)}
                    className="text-slate-400 hover:text-slate-200"
                  >
                    ✕
                  </button>
                </div>

                {gitFeedback && (
                  <div className="text-[11px] font-mono bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-amber-300 break-words">
                    {gitFeedback}
                  </div>
                )}

                {!gitInfo.isRepo ? (
                  <div className="space-y-2">
                    <p className="text-[11px] text-slate-400">
                      This workspace is not a Git repository yet.
                    </p>
                    <button
                      disabled={gitBusy}
                      onClick={async () => {
                        setGitBusy(true);
                        setGitFeedback(null);
                        try {
                          const res = await fetch("/api/git", {
                            method: "POST",
                            headers: {
                              "Content-Type": "application/json",
                              "x-session-id": sid,
                            },
                            body: JSON.stringify({ sid, action: "init" }),
                          });
                          const d = await res.json().catch(() => ({}));
                          if (d.error) setGitFeedback(`⚠️ ${d.error}`);
                          else setGitFeedback("✅ Initialized Git repository");
                          await fetchGitStatus();
                        } finally {
                          setGitBusy(false);
                        }
                      }}
                      className="w-full bg-teal-600 hover:bg-teal-500 text-white py-1.5 rounded text-xs font-medium"
                    >
                      Initialize Git Repository (git init)
                    </button>
                  </div>
                ) : (
                  <>
                    {/* Branch Switcher */}
                    <div className="space-y-1">
                      <div className="text-[10px] text-slate-400 font-mono flex justify-between">
                        <span>Current Branch: {gitInfo.branch}</span>
                        <button
                          onClick={fetchGitStatus}
                          className="text-teal-400 hover:underline"
                        >
                          ↻ Refresh
                        </button>
                      </div>
                      {gitInfo.branches.length > 1 && (
                        <select
                          value={gitInfo.branch || ""}
                          onChange={async (e) => {
                            const target = e.target.value;
                            if (!target) return;
                            setGitBusy(true);
                            setGitFeedback(null);
                            try {
                              const res = await fetch("/api/git", {
                                method: "POST",
                                headers: {
                                  "Content-Type": "application/json",
                                  "x-session-id": sid,
                                },
                                body: JSON.stringify({
                                  sid,
                                  action: "checkout",
                                  branch: target,
                                }),
                              });
                              const d = await res.json().catch(() => ({}));
                              if (d.error) setGitFeedback(`⚠️ ${d.error}`);
                              await fetchGitStatus();
                            } finally {
                              setGitBusy(false);
                            }
                          }}
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-200"
                        >
                          {gitInfo.branches.map((b) => (
                            <option key={b} value={b}>
                              🌿 {b}
                            </option>
                          ))}
                        </select>
                      )}
                      <form
                        onSubmit={async (e) => {
                          e.preventDefault();
                          if (!newBranchName.trim()) return;
                          setGitBusy(true);
                          setGitFeedback(null);
                          try {
                            const res = await fetch("/api/git", {
                              method: "POST",
                              headers: {
                                "Content-Type": "application/json",
                                "x-session-id": sid,
                              },
                              body: JSON.stringify({
                                sid,
                                action: "checkout",
                                branch: newBranchName.trim(),
                                create: true,
                              }),
                            });
                            const d = await res.json().catch(() => ({}));
                            if (d.error) {
                              setGitFeedback(`⚠️ ${d.error}`);
                            } else {
                              setGitFeedback(
                                `✅ Switched to ${newBranchName.trim()}`
                              );
                              setNewBranchName("");
                            }
                            await fetchGitStatus();
                          } finally {
                            setGitBusy(false);
                          }
                        }}
                        className="flex gap-1"
                      >
                        <input
                          type="text"
                          value={newBranchName}
                          onChange={(e) => setNewBranchName(e.target.value)}
                          placeholder="New branch (e.g. feat/ui)…"
                          className="flex-1 bg-slate-950 border border-slate-800 rounded px-2 py-1 text-[11px] font-mono text-slate-200"
                        />
                        <button
                          type="submit"
                          disabled={gitBusy}
                          className="bg-slate-800 hover:bg-slate-700 text-slate-200 px-2 py-1 rounded text-[10px]"
                        >
                          + Branch
                        </button>
                      </form>
                    </div>

                    {/* Uncommitted Changes List */}
                    <div className="space-y-1">
                      <div className="text-[10px] text-slate-400 font-mono">
                        Uncommitted Changes ({gitInfo.changes.length}):
                      </div>
                      <div className="max-h-32 overflow-y-auto bg-slate-950 border border-slate-800 rounded p-1.5 space-y-1">
                        {gitInfo.changes.length === 0 ? (
                          <div className="text-[11px] text-slate-500 italic">
                            Working tree clean.
                          </div>
                        ) : (
                          gitInfo.changes.map((c, idx) => (
                            <div
                              key={`${c.path}-${idx}`}
                              className="flex items-center justify-between text-[11px] font-mono"
                            >
                              <span className="truncate text-slate-300">
                                {c.path}
                              </span>
                              <span className="text-amber-400 ml-2 shrink-0">
                                {c.status}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    {/* Commit Box & AI Commit Button */}
                    {gitInfo.changes.length > 0 && (
                      <div className="space-y-1.5 pt-1 border-t border-slate-800">
                        <input
                          type="text"
                          value={commitMsg}
                          onChange={(e) => setCommitMsg(e.target.value)}
                          placeholder="Commit message (e.g. feat: add auth)…"
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs font-mono text-slate-100"
                        />
                        <div className="flex gap-1.5">
                          <button
                            disabled={gitBusy || !commitMsg.trim()}
                            onClick={async () => {
                              setGitBusy(true);
                              setGitFeedback(null);
                              try {
                                const res = await fetch("/api/git", {
                                  method: "POST",
                                  headers: {
                                    "Content-Type": "application/json",
                                    "x-session-id": sid,
                                  },
                                  body: JSON.stringify({
                                    sid,
                                    action: "commit",
                                    message: commitMsg.trim(),
                                  }),
                                });
                                const d = await res.json().catch(() => ({}));
                                if (d.error) {
                                  setGitFeedback(`⚠️ ${d.error}`);
                                } else {
                                  setGitFeedback(
                                    `✅ Committed: "${commitMsg.trim()}"`
                                  );
                                  setCommitMsg("");
                                }
                                await fetchGitStatus();
                              } finally {
                                setGitBusy(false);
                              }
                            }}
                            className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white py-1.5 rounded text-xs font-medium"
                          >
                            ✓ Stage All &amp; Commit
                          </button>
                          <button
                            disabled={gitBusy}
                            onClick={async () => {
                              setGitBusy(true);
                              try {
                                const res = await fetch("/api/git", {
                                  method: "POST",
                                  headers: {
                                    "Content-Type": "application/json",
                                    "x-session-id": sid,
                                  },
                                  body: JSON.stringify({
                                    sid,
                                    action: "diff-summary",
                                  }),
                                });
                                const d = await res.json().catch(() => ({}));
                                const summary = `Status:\n${d.status || ""}\n\nDiff Stat:\n${d.stat || ""}\n\nPatch Excerpt:\n${d.patch || ""}`;
                                setGitOpen(false);
                                onAskAiCommitMessage(summary);
                              } finally {
                                setGitBusy(false);
                              }
                            }}
                            className="bg-indigo-600/40 hover:bg-indigo-600/60 border border-indigo-500/40 text-indigo-200 px-2 py-1.5 rounded text-[11px]"
                            title="Ask AI to inspect git diff and propose a Conventional Commit command"
                          >
                            ✨ AI Commit
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          title="Select AI Model"
          className="bg-slate-950 border border-slate-700 text-emerald-300 rounded px-2 py-1 font-mono text-[11px] focus:outline-none focus:border-emerald-500"
        >
          {modelsList.map((m) => (
            <option key={m} value={m}>
              🤖 {m}
            </option>
          ))}
        </select>

        {/* Live Vertex AI Credential Health Check Badge & Popover */}
        <div className="relative">
          <button
            onClick={async () => {
              const next = !authOpen;
              setAuthOpen(next);
              setSessOpen(false);
              setCpOpen(false);
              setGitOpen(false);
              if (next) await fetchAuthStatus(true);
            }}
            className={`px-2 py-1 rounded font-mono text-[11px] border flex items-center gap-1 transition-colors ${
              authInfo?.configured
                ? "bg-emerald-950/60 border-emerald-500/50 text-emerald-300 hover:bg-emerald-900/50"
                : "bg-amber-950/60 border-amber-500/50 text-amber-300 hover:bg-amber-900/50"
            }`}
            title={
              authInfo?.configured
                ? `Vertex AI Auth Ready via ${authInfo.sourceLabel}`
                : "Vertex AI Credentials Missing or Invalid — Click to inspect .env status"
            }
          >
            <span>{authInfo?.configured ? "🔑" : "⚠️"}</span>
            <span>
              {authInfo?.configured
                ? authInfo.source === "key-file"
                  ? "JSON Ready"
                  : ".env Ready"
                : authInfo?.source !== "missing" && authInfo && !authInfo.validPemKey
                  ? "Invalid Key"
                  : "Auth Missing"}
            </span>
          </button>

          {authOpen && (
            <div className="absolute left-0 mt-1 w-80 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-3 z-50 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-xs text-emerald-300">
                  🔑 Vertex AI Credential Status
                </span>
                <button
                  onClick={() => setAuthOpen(false)}
                  className="text-slate-400 hover:text-slate-200"
                >
                  ✕
                </button>
              </div>

              {authInfo ? (
                <div className="space-y-1.5 text-[11px] font-mono">
                  <div
                    className={`p-2 rounded border ${
                      authInfo.configured
                        ? "bg-emerald-950/40 border-emerald-500/40 text-emerald-200"
                        : "bg-rose-950/40 border-rose-500/40 text-rose-200"
                    }`}
                  >
                    {authInfo.configured
                      ? "✅ Service Account Authenticated"
                      : authInfo.pemError
                        ? "❌ Invalid Private Key (OpenSSL Decoder)"
                        : "❌ Credentials Not Configured"}
                  </div>
                  <div className="bg-slate-950 border border-slate-800 rounded p-2 space-y-1 text-slate-300">
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Source:</span>
                      <span className="text-right truncate text-sky-300">
                        {authInfo.sourceLabel}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">GCP Project:</span>
                      <span className="text-emerald-300">
                        {authInfo.project}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Location:</span>
                      <span>{authInfo.location}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Client Email:</span>
                      <span className="truncate">
                        {authInfo.maskedClientEmail || "not set"}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">OpenSSL PEM:</span>
                      <span>
                        {authInfo.validPemKey
                          ? "✅ Verified PKCS#8"
                          : "⚠️ Failed Decode"}
                      </span>
                    </div>
                    {authInfo.pemError && (
                      <div className="text-[10px] text-rose-300 bg-rose-950/40 border border-rose-500/30 rounded p-1.5 break-words">
                        {authInfo.pemError}
                      </div>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-400 font-sans leading-relaxed">
                    {authInfo.hint}
                  </p>
                </div>
              ) : (
                <div className="text-xs text-slate-400">
                  Checking credentials…
                </div>
              )}

              <button
                disabled={authChecking}
                onClick={() => fetchAuthStatus(true)}
                className="w-full bg-emerald-600/30 hover:bg-emerald-600/50 border border-emerald-500/40 text-emerald-200 py-1.5 rounded text-xs font-medium"
              >
                {authChecking
                  ? "↻ Reloading .env…"
                  : "↻ Reload .env & Verify Now"}
              </button>
            </div>
          )}
        </div>

        {/* Completion Sound & Notification Toggle */}
        <button
          onClick={async () => {
            unlockAudioContext();
            const next = !soundOn;
            setSoundEnabled(next);
            setSoundOn(next);
            if (next) {
              playCompletionSound("build", true);
              await requestDesktopNotificationPermission();
            }
          }}
          className={`px-2 py-1 rounded font-mono text-[11px] border flex items-center gap-1 transition-colors ${
            soundOn
              ? "bg-emerald-950/60 border-emerald-500/40 text-emerald-300 hover:bg-emerald-900/50"
              : "bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200"
          }`}
          title={
            soundOn
              ? "AI Completion Sound & Desktop Notification ON (click to mute)"
              : "AI Completion Sound Muted (click to enable & hear chime)"
          }
        >
          <span>{soundOn ? "🔔" : "🔕"}</span>
          <span>{soundOn ? "Chime ON" : "Muted"}</span>
        </button>

        <span className="bg-slate-950 border border-slate-800 px-2 py-1 rounded text-sky-300 font-mono">
          {ctxLabel}
        </span>
        <span className="bg-slate-950 border border-slate-800 px-2 py-1 rounded text-blue-400 font-mono">
          {turnsLabel}
        </span>

        {/* Live Root .zt-storage/ Disk & SHA-1 Deduplication Stats Pill + Instant Clear Button */}
        <div className="flex items-center bg-slate-950 border border-emerald-500/30 rounded overflow-hidden">
          <span
            className="px-2 py-1 text-emerald-300 font-mono"
            title="Root ./.zt-storage/ Content-Addressable Disk Engine (SHA-1 deduplicated blobs + 24h auto-purge)"
          >
            💾{" "}
            {storageStats
              ? `${fmtBytes(storageStats.totalBytes)} · ${storageStats.blobCount} blobs`
              : ".zt-storage"}{" "}
            · ⏳ {ttlLabel}
          </span>
          <button
            disabled={clearingAll}
            onClick={async () => {
              setClearingAll(true);
              try {
                await onClearAllStorage();
                setSessOpen(false);
              } finally {
                setClearingAll(false);
              }
            }}
            className="bg-rose-950/60 hover:bg-rose-800/70 border-l border-emerald-500/30 text-rose-200 px-2 py-1 text-[11px] font-medium transition-colors"
            title="Clear all .zt-storage/ disk blobs & session history now"
          >
            {clearingAll ? "Clearing…" : "🧹 Clear Storage"}
          </button>
        </div>

        {/* 24h Session History Switcher & Reload Drawer */}
        <div className="relative">
          <button
            onClick={async () => {
              const next = !sessOpen;
              setSessOpen(next);
              setCpOpen(false);
              setGitOpen(false);
              setAuthOpen(false);
              setEditingSid(null);
              if (next) await onRefreshSessions();
            }}
            className="bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 rounded text-indigo-300 font-mono"
            title="Reload, rename, or switch between saved 24-hour sessions (grouped by project folder path & custom name)"
          >
            🗂️ Sessions ({storedSessions.length || 1})
          </button>
          {sessOpen && (
            <div className="absolute left-0 mt-1 w-96 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-3 z-50 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-xs text-indigo-300">
                  🗂️ Project Folder &amp; Named Sessions
                </span>
                <button
                  onClick={() => {
                    setSessOpen(false);
                    setEditingSid(null);
                  }}
                  className="text-slate-400 hover:text-slate-200"
                >
                  ✕
                </button>
              </div>
              <p className="text-[10px] text-slate-400 leading-relaxed">
                Sessions are linked to your <b>workspace folder path</b> and can
                also be given a custom name (<b>✏️</b>). Picking the same folder
                again automatically restores its history!
              </p>
              {storageStats && (
                <div className="bg-slate-950 border border-slate-800 rounded p-2 text-[10px] font-mono text-slate-300 flex justify-between">
                  <span>Total Disk: {fmtBytes(storageStats.totalBytes)}</span>
                  <span>
                    SHA-1 Blobs: {storageStats.blobCount} (
                    {fmtBytes(storageStats.blobBytes)})
                  </span>
                </div>
              )}
              <div className="flex gap-1.5">
                <button
                  onClick={async () => {
                    await onCreateNewSession();
                    setSessOpen(false);
                  }}
                  className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white py-1.5 rounded text-xs font-medium"
                >
                  + New 24h Session
                </button>
                <button
                  disabled={gcRunning}
                  onClick={async () => {
                    setGcRunning(true);
                    try {
                      await onRunGarbageCollection();
                    } finally {
                      setGcRunning(false);
                    }
                  }}
                  className="bg-emerald-600/30 hover:bg-emerald-600/50 border border-emerald-500/40 text-emerald-200 px-2.5 py-1.5 rounded text-[11px] font-mono shrink-0"
                  title="Sweep unreferenced SHA-1 blobs and expired sessions from ./.zt-storage/"
                >
                  {gcRunning ? "🧹 Sweeping…" : "🧹 Blob GC"}
                </button>
              </div>
              <button
                disabled={clearingAll}
                onClick={async () => {
                  setClearingAll(true);
                  try {
                    await onClearAllStorage();
                    setSessOpen(false);
                  } finally {
                    setClearingAll(false);
                  }
                }}
                className="w-full bg-rose-600/25 hover:bg-rose-600/45 border border-rose-500/40 text-rose-200 py-1.5 rounded text-[11px] font-medium"
              >
                {clearingAll
                  ? "Wiping Storage…"
                  : "🔥 Wipe All .zt-storage/ Disk Storage Now"}
              </button>
              <div className="max-h-60 overflow-y-auto space-y-1.5 pt-1">
                {storedSessions.length === 0 ? (
                  <div className="text-[11px] text-slate-500 italic">
                    No saved sessions found.
                  </div>
                ) : (
                  storedSessions.map((item) => {
                    const isCurrent = item.id === sid;
                    const isEditing = editingSid === item.id;
                    return (
                      <div
                        key={item.id}
                        className={`border rounded p-2 flex flex-col gap-1.5 ${
                          isCurrent
                            ? "bg-indigo-950/40 border-indigo-500/50"
                            : "bg-slate-950 border-slate-800"
                        }`}
                      >
                        {isEditing ? (
                          <form
                            onSubmit={async (e) => {
                              e.preventDefault();
                              await onRenameSession(item.id, editingTitle);
                              setEditingSid(null);
                            }}
                            className="flex items-center gap-1"
                          >
                            <input
                              type="text"
                              value={editingTitle}
                              onChange={(e) => setEditingTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Escape") {
                                  e.stopPropagation();
                                  setEditingSid(null);
                                }
                              }}
                              placeholder="Session name..."
                              maxLength={80}
                              autoFocus
                              className="flex-1 min-w-0 bg-slate-900 border border-indigo-500/60 rounded px-2 py-0.5 text-xs text-slate-100 focus:outline-none"
                            />
                            <button
                              type="submit"
                              className="bg-emerald-600 hover:bg-emerald-500 text-white px-2 py-0.5 rounded text-[10px] font-medium shrink-0"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingSid(null)}
                              className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded text-[10px] shrink-0"
                            >
                              ✕
                            </button>
                          </form>
                        ) : (
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div
                                className="text-xs text-slate-200 font-medium truncate flex items-center gap-1.5"
                                title={item.title}
                              >
                                {isCurrent && (
                                  <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                                )}
                                <span className="truncate">{item.title}</span>
                              </div>
                              {item.root && (
                                <div
                                  className="text-[10px] text-emerald-400/90 font-mono truncate"
                                  title={item.root}
                                >
                                  📁 {item.root}
                                </div>
                              )}
                              <div className="text-[10px] text-slate-400 font-mono truncate">
                                {item.turns} turns · {item.pendingProposals}{" "}
                                pending · ⏳{" "}
                                {formatRemainingTTL(item.expiresAt)}
                              </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                onClick={() => {
                                  setEditingSid(item.id);
                                  setEditingTitle(item.title);
                                }}
                                className="bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-1.5 py-1 rounded text-[10px]"
                                title="Rename this session"
                              >
                                ✏️
                              </button>
                              <button
                                onClick={async () => {
                                  await onSwitchSession(item.id);
                                  setSessOpen(false);
                                }}
                                className="bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-200 border border-emerald-500/40 px-2 py-1 rounded text-[10px]"
                                title={
                                  isCurrent
                                    ? "Reload this session's state from disk"
                                    : "Switch to and reload this session"
                                }
                              >
                                {isCurrent ? "↻ Reload" : "Switch"}
                              </button>
                              <button
                                onClick={async () => {
                                  await onDeleteSession(item.id);
                                }}
                                className="bg-rose-600/20 hover:bg-rose-600/40 text-rose-300 border border-rose-500/30 px-1.5 py-1 rounded text-[10px]"
                                title="Delete session from disk"
                              >
                                🗑️
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        <button
          onClick={onRefreshContext}
          className="bg-slate-800 hover:bg-slate-700 px-2 py-1 rounded text-slate-300"
          title="Re-read the whole project from disk"
        >
          🔄 Re-read
        </button>
        <button
          onClick={onNewChat}
          className="bg-slate-800 hover:bg-slate-700 px-2 py-1 rounded text-slate-300"
          title="Clear chat memory now"
        >
          🗑️ Clear Chat
        </button>
        <button
          onClick={onExportChat}
          className="bg-slate-800 hover:bg-slate-700 px-2 py-1 rounded text-slate-300"
          title="Download this chat as Markdown"
        >
          ⬇ Export
        </button>
        <button
          onClick={onUndo}
          className="bg-slate-800 hover:bg-slate-700 px-2 py-1 rounded text-slate-300"
          title="Revert the last approved change"
        >
          ↩️ Undo ({undoCount})
        </button>

        {/* 24h Deduplicated Disk Checkpoints Dropdown */}
        <div className="relative">
          <button
            onClick={() => {
              setCpOpen(!cpOpen);
              setSessOpen(false);
              setGitOpen(false);
              setAuthOpen(false);
            }}
            className="bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 rounded text-amber-300 font-mono"
            title="Deduplicated SHA-1 disk checkpoints (retained for 24h)"
          >
            📌 Checkpoints ({checkpoints.length})
          </button>
          {cpOpen && (
            <div className="absolute left-0 mt-1 w-80 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-3 z-50 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-xs text-amber-300">
                  📌 Deduplicated Disk Checkpoints
                </span>
                <button
                  onClick={() => setCpOpen(false)}
                  className="text-slate-400 hover:text-slate-200"
                >
                  ✕
                </button>
              </div>
              <p className="text-[10px] text-slate-400">
                Snapshots your workspace into SHA-1 deduplicated blobs in{" "}
                <code>.zt-storage/blobs/</code>. Click <b>🔍 Compare</b> for a
                side-by-side diff before restoring.
              </p>
              <button
                onClick={async () => {
                  const name =
                    window.prompt(
                      "Checkpoint name (e.g. Working UI before refactor):"
                    ) || "";
                  if (!name.trim()) return;
                  await onCreateCheckpoint(name.trim());
                }}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white py-1.5 rounded text-xs font-medium"
              >
                + Save Current Workspace State
              </button>
              <div className="max-h-48 overflow-y-auto space-y-1 pt-1">
                {checkpoints.length === 0 ? (
                  <div className="text-[11px] text-slate-500 italic">
                    No checkpoints saved in this session yet.
                  </div>
                ) : (
                  checkpoints.map((cp) => (
                    <div
                      key={cp.id}
                      className="bg-slate-950 border border-slate-800 rounded p-2 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-slate-200 font-medium truncate">
                          {cp.name}
                        </div>
                        <div className="text-[10px] text-slate-500 font-mono">
                          {cp.fileCount} files ·{" "}
                          {new Date(cp.ts).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={async () => {
                            await onCompareCheckpoint(cp);
                            setCpOpen(false);
                          }}
                          className="bg-sky-600/30 hover:bg-sky-600/50 text-sky-200 border border-sky-500/40 px-2 py-1 rounded text-[10px]"
                          title="Compare current workspace vs this checkpoint side-by-side"
                        >
                          🔍 Compare
                        </button>
                        <button
                          onClick={async () => {
                            await onRestoreCheckpoint(cp.id, cp.name);
                            setCpOpen(false);
                          }}
                          className="bg-amber-600/30 hover:bg-amber-600/50 text-amber-200 border border-amber-500/40 px-2 py-1 rounded text-[10px]"
                        >
                          ⏪ Restore
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <button
          onClick={onOpenCommandPalette}
          className="bg-slate-950 hover:bg-slate-800 border border-slate-700 px-2 py-1 rounded text-emerald-300 font-mono"
          title="Open Developer Command Palette (Ctrl+K / Cmd+K)"
        >
          ⌘K
        </button>
      </div>

      {/* Window Management Toggles + Live App Preview Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center bg-slate-950 border border-slate-800 rounded p-0.5 gap-0.5">
          <span className="text-[10px] text-slate-500 px-1.5 font-semibold uppercase tracking-wider">
            Windows:
          </span>
          <button
            onClick={() => setShowExplorer(!showExplorer)}
            className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
              showExplorer
                ? "bg-purple-600/30 text-purple-300 border border-purple-500/40"
                : "text-slate-500 hover:text-slate-300"
            }`}
            title="Toggle VS Code-style File Explorer & Code Search"
          >
            📂 Explorer
          </button>
          <button
            onClick={() => setShowChat(!showChat)}
            className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
              showChat
                ? "bg-emerald-600/30 text-emerald-300 border border-emerald-500/40"
                : "text-slate-500 hover:text-slate-300"
            }`}
            title="Toggle Chat Window"
          >
            💬 Chat
          </button>
          <button
            onClick={() => setShowPreview(!showPreview)}
            className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
              showPreview
                ? "bg-blue-600/30 text-blue-300 border border-blue-500/40"
                : "text-slate-500 hover:text-slate-300"
            }`}
            title="Toggle Preview Window"
          >
            🌐 Preview
          </button>
          <button
            onClick={() => setShowTerminal(!showTerminal)}
            className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
              showTerminal
                ? "bg-amber-600/30 text-amber-300 border border-amber-500/40"
                : "text-slate-500 hover:text-slate-300"
            }`}
            title="Toggle Sandbox Terminal Window"
          >
            💻 Terminal
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => {
              setShowPreview(true);
              onReloadPreview();
            }}
            className="bg-emerald-600 hover:bg-emerald-500 px-2.5 py-1 rounded text-white font-semibold flex items-center gap-1 shadow-sm"
            title="Show and reload the live application preview pane"
          >
            🚀 See App Preview
          </button>
          <input
            type="text"
            value={previewUrl}
            onChange={(e) => setPreviewUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                setShowPreview(true);
                onReloadPreview();
              }
            }}
            placeholder="Preview URL (Enter to load)..."
            className="bg-slate-950 border border-slate-700 rounded px-2 py-1 w-40 font-mono text-emerald-400"
          />
          <button
            onClick={onReloadPreview}
            className="bg-blue-600 hover:bg-blue-500 px-2 py-1 rounded text-white font-medium"
            title="Reload preview iframe"
          >
            ↻
          </button>
          <button
            onClick={onOpenPreviewInNewTab}
            className="bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 rounded text-sky-300 font-medium"
            title="Open live application preview in a new browser tab"
          >
            ↗ Tab
          </button>
        </div>
      </div>
    </header>
  );
}