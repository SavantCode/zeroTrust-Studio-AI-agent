"use client";

import React, { useEffect, useState } from "react";
import type { StoredSessionSummary } from "@/types/builder";

interface SetupModalProps {
  open: boolean;
  note?: string;
  onLock: (folderPath: string, allowCreate: boolean) => Promise<void>;
  onClose?: () => void;
  canClose: boolean;
}

const RECENT_KEY = "zt_recent_workspaces";

export default function SetupModal({
  open,
  note,
  onLock,
  onClose,
  canClose,
}: SetupModalProps) {
  const [folderPath, setFolderPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const [savedFolderSessions, setSavedFolderSessions] = useState<
    StoredSessionSummary[]
  >([]);

  useEffect(() => {
    if (!open) return;
    try {
      const saved = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      if (Array.isArray(saved)) setRecents(saved.slice(0, 5));
    } catch {
      // ignore
    }
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d?.sessions)) {
          setSavedFolderSessions(
            d.sessions.filter((s: StoredSessionSummary) => Boolean(s.root))
          );
        }
      })
      .catch(() => {
        // ignore
      });
  }, [open]);

  if (!open) return null;

  const saveRecent = (pathStr: string) => {
    try {
      const next = [pathStr, ...recents.filter((r) => r !== pathStr)].slice(
        0,
        5
      );
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      setRecents(next);
    } catch {
      // ignore
    }
  };

  const lockTo = async (targetPath: string) => {
    if (!targetPath.trim()) return;
    setLoading(true);
    try {
      saveRecent(targetPath.trim());
      await onLock(targetPath.trim(), false);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await lockTo(folderPath);
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
      <form
        onSubmit={handleSubmit}
        className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-lg w-full shadow-2xl space-y-4"
      >
        <div className="flex items-center justify-between">
          <div className="text-amber-400 font-bold text-lg">
            🛡️ Choose your workspace folder
          </div>
          {canClose && onClose && (
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-200 text-sm"
            >
              ✕
            </button>
          )}
        </div>
        <p className="text-xs text-slate-300 leading-relaxed">
          {note ||
            "The AI can only touch this folder. If you pick a folder you worked on earlier, Zero-Trust Studio automatically remembers and restores its chat history, checkpoints, and undo stack from ./.zt-storage/."}
        </p>
        <input
          type="text"
          value={folderPath}
          onChange={(e) => setFolderPath(e.target.value)}
          placeholder="e.g. C:\Users\You\Desktop\my-app or ./my-sandbox"
          className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-sm font-mono text-emerald-400 focus:outline-none focus:border-emerald-500"
        />

        {savedFolderSessions.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[11px] text-indigo-300 font-medium flex items-center justify-between">
              <span>🧠 Saved Project Sessions (Auto-Resumes Chat History):</span>
            </div>
            <div className="flex flex-col gap-1 max-h-36 overflow-y-auto">
              {savedFolderSessions.slice(0, 5).map((sess) => (
                <button
                  key={sess.id}
                  type="button"
                  onClick={() => {
                    if (sess.root) {
                      setFolderPath(sess.root);
                      lockTo(sess.root);
                    }
                  }}
                  className="text-left text-xs font-mono bg-indigo-950/30 hover:bg-indigo-900/40 border border-indigo-500/30 rounded px-2.5 py-1.5 text-slate-200 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-emerald-300 font-semibold truncate">
                      {sess.title}
                    </div>
                    <div className="text-[10px] text-slate-400 truncate">
                      📁 {sess.root}
                    </div>
                  </div>
                  <span className="text-[10px] bg-indigo-900/70 text-indigo-200 px-1.5 py-0.5 rounded shrink-0">
                    {sess.turns} turns
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {recents.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[11px] text-slate-400 font-medium">
              Recent Workspace Paths:
            </div>
            <div className="flex flex-col gap-1">
              {recents.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => {
                    setFolderPath(r);
                    lockTo(r);
                  }}
                  className="text-left text-xs font-mono bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded px-2.5 py-1.5 text-slate-300 truncate"
                >
                  📁 {r}
                </button>
              ))}
            </div>
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold py-2.5 rounded-lg text-sm"
        >
          {loading ? "Locking & Restoring History…" : "🔒 Lock to this folder"}
        </button>
      </form>
    </div>
  );
}