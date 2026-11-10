"use client";

import React, { useEffect, useMemo, useState } from "react";
import type { ChatMode } from "@/types/builder";

export interface PaletteCommandItem {
  id: string;
  category: "Action" | "File" | "Terminal" | "Window";
  label: string;
  hint?: string;
  onRun: () => void;
}

interface CommandPaletteModalProps {
  open: boolean;
  onClose: () => void;
  files: string[];
  chatMode: ChatMode;
  setChatMode: (m: ChatMode) => void;
  onSelectFile: (relPath: string) => void;
  onPinFile: (relPath: string) => void;
  onRunCommand: (cmd: string) => void;
  onCreateCheckpoint: () => void;
  onOpenSetup: () => void;
  onRefreshContext: () => void;
  onUndo: () => void;
  onClearStorage: () => void;
  onToggleExplorer: () => void;
  onToggleChat: () => void;
  onTogglePreview: () => void;
  onToggleTerminal: () => void;
}

export default function CommandPaletteModal({
  open,
  onClose,
  files,
  chatMode,
  setChatMode,
  onSelectFile,
  onPinFile,
  onRunCommand,
  onCreateCheckpoint,
  onOpenSetup,
  onRefreshContext,
  onUndo,
  onClearStorage,
  onToggleExplorer,
  onToggleChat,
  onTogglePreview,
  onToggleTerminal,
}: CommandPaletteModalProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
    }
  }, [open]);

  const allItems = useMemo<PaletteCommandItem[]>(() => {
    const actions: PaletteCommandItem[] = [
      {
        id: "act-mode-toggle",
        category: "Action",
        label:
          chatMode === "build"
            ? "💬 Switch to Talk & Architecture Plan Mode"
            : "🔨 Switch to Build & Code Mode",
        hint: "Mode",
        onRun: () => setChatMode(chatMode === "build" ? "talk" : "build"),
      },
      {
        id: "act-cp-create",
        category: "Action",
        label: "📌 Create Workspace Checkpoint",
        hint: "SHA-1 Snapshot",
        onRun: onCreateCheckpoint,
      },
      {
        id: "act-undo",
        category: "Action",
        label: "↩️ Undo Last Approved File Turn",
        hint: "Revert",
        onRun: onUndo,
      },
      {
        id: "act-reread",
        category: "Action",
        label: "🔄 Re-read Project Snapshot from Disk",
        hint: "Context",
        onRun: onRefreshContext,
      },
      {
        id: "act-folder",
        category: "Action",
        label: "🔒 Switch / Lock Workspace Folder",
        hint: "Setup",
        onRun: onOpenSetup,
      },
      {
        id: "act-clear-storage",
        category: "Action",
        label: "🧹 Clear .zt-storage/ Disk Cache & Sessions",
        hint: "Storage",
        onRun: onClearStorage,
      },
      {
        id: "win-explorer",
        category: "Window",
        label: "📂 Toggle File Explorer Sidebar",
        hint: "Window",
        onRun: onToggleExplorer,
      },
      {
        id: "win-chat",
        category: "Window",
        label: "💬 Toggle AI Chat Window",
        hint: "Window",
        onRun: onToggleChat,
      },
      {
        id: "win-preview",
        category: "Window",
        label: "🌐 Toggle Live App Preview Window",
        hint: "Window",
        onRun: onTogglePreview,
      },
      {
        id: "win-term",
        category: "Window",
        label: "💻 Toggle Sandbox Terminal Window",
        hint: "Window",
        onRun: onToggleTerminal,
      },
      {
        id: "term-tsc",
        category: "Terminal",
        label: "⚡ Run TypeScript Check (npx tsc --noEmit)",
        hint: "Terminal",
        onRun: () => onRunCommand("npx tsc --noEmit"),
      },
      {
        id: "term-git-status",
        category: "Terminal",
        label: "⚡ Run git status --short",
        hint: "Terminal",
        onRun: () => onRunCommand("git status --short"),
      },
      {
        id: "term-test",
        category: "Terminal",
        label: "⚡ Run npm test",
        hint: "Terminal",
        onRun: () => onRunCommand("npm test"),
      },
      {
        id: "term-install",
        category: "Terminal",
        label: "⚡ Run npm install",
        hint: "Terminal",
        onRun: () => onRunCommand("npm install"),
      },
    ];

    const fileItems: PaletteCommandItem[] = files.map((f) => ({
      id: `file-open-${f}`,
      category: "File",
      label: `📄 Open ${f}`,
      hint: "Edit in Studio",
      onRun: () => onSelectFile(f),
    }));

    const pinItems: PaletteCommandItem[] = files.slice(0, 60).map((f) => ({
      id: `file-pin-${f}`,
      category: "File",
      label: `📌 Pin @${f} to AI Prompt`,
      hint: "@Mention",
      onRun: () => onPinFile(f),
    }));

    return [...actions, ...fileItems, ...pinItems];
  }, [
    files,
    chatMode,
    setChatMode,
    onCreateCheckpoint,
    onUndo,
    onRefreshContext,
    onOpenSetup,
    onClearStorage,
    onToggleExplorer,
    onToggleChat,
    onTogglePreview,
    onToggleTerminal,
    onRunCommand,
    onSelectFile,
    onPinFile,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allItems.slice(0, 30);
    return allItems
      .filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          item.category.toLowerCase().includes(q) ||
          (item.hint && item.hint.toLowerCase().includes(q))
      )
      .slice(0, 40);
  }, [allItems, query]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[65] bg-black/75 backdrop-blur-sm flex items-start justify-center pt-20 p-4"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b border-slate-800 flex items-center gap-2 bg-slate-950">
          <span className="text-emerald-400 font-mono text-sm">⌘K</span>
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                if (filtered.length > 0) {
                  setCursor((c) => (c + 1) % filtered.length);
                }
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                if (filtered.length > 0) {
                  setCursor((c) => (c - 1 + filtered.length) % filtered.length);
                }
              } else if (e.key === "Enter" && filtered[cursor]) {
                e.preventDefault();
                filtered[cursor].onRun();
                onClose();
              }
            }}
            placeholder="Type a command or search files to open / @pin…"
            autoFocus
            className="flex-1 bg-transparent text-sm font-mono text-slate-100 focus:outline-none"
          />
          <span className="text-[10px] text-slate-500 font-mono">
            ESC to close
          </span>
        </div>

        <div className="max-h-80 overflow-y-auto p-1.5 space-y-0.5">
          {filtered.length === 0 ? (
            <div className="p-4 text-xs text-slate-500 text-center">
              No matching commands or workspace files.
            </div>
          ) : (
            filtered.map((item, idx) => {
              const active = idx === cursor;
              return (
                <button
                  key={item.id}
                  type="button"
                  onMouseEnter={() => setCursor(idx)}
                  onClick={() => {
                    item.onRun();
                    onClose();
                  }}
                  className={`w-full text-left px-3 py-2 rounded-lg text-xs font-mono flex items-center justify-between gap-2 transition-colors ${
                    active
                      ? "bg-emerald-600/30 text-emerald-200 border border-emerald-500/40"
                      : "text-slate-300 hover:bg-slate-800/70 border border-transparent"
                  }`}
                >
                  <span className="truncate">{item.label}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-950 text-slate-400 shrink-0">
                    {item.hint || item.category}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}