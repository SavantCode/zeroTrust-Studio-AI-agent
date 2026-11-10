"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  BrowserConsoleEntry,
  CommandProposal,
} from "@/types/builder";
import type { EnrichedProposal } from "@/lib/diff";

export interface OpenEditorTab {
  relPath: string;
  content: string;
  originalContent: string;
  size: number;
  isNew?: boolean;
}

interface RightPaneProps {
  files: string[];
  proposals: Record<string, EnrichedProposal>;
  commands: Record<string, CommandProposal>;
  previewSrc: string;
  logs: string;
  browserLogs: BrowserConsoleEntry[];
  onClearBrowserLogs: () => void;
  onFixBrowserErrors: () => void;
  running: boolean;
  autoPreviewUrl: string | null;
  autoVerify: boolean;
  setAutoVerify: (v: boolean) => void;
  autoHeal: boolean;
  setAutoHeal: (v: boolean) => void;
  showPreview: boolean;
  setShowPreview: (v: boolean) => void;
  showTerminal: boolean;
  setShowTerminal: (v: boolean) => void;
  isDraggingGlobal: boolean;
  openTabs: OpenEditorTab[];
  activeTabPath: string | null;
  editorFocusSeq: number;
  setActiveTabPath: (path: string | null) => void;
  onUpdateTabContent: (relPath: string, nextContent: string) => void;
  onSaveTab: (relPath: string) => Promise<void>;
  onDeleteTabFile: (relPath: string) => Promise<void>;
  onCloseTab: (relPath: string) => void;
  onPinFileToChat: (relPath: string) => void;
  onOpenReview: (id?: string) => void;
  onApproveWrite: (id: string) => Promise<boolean>;
  onRejectWrite: (id: string) => Promise<void>;
  onApproveCommand: (id: string) => Promise<unknown>;
  onRejectCommand: (id: string) => Promise<void>;
  onApproveAll: () => Promise<void>;
  onRunManualCommand: (cmd: string) => Promise<unknown>;
  onFixErrors: () => void;
  onStopProcess: () => void;
  onRefreshLogs: () => void;
  onClearLogs: () => void;
  onCopyLogs: () => void;
  onInspectFile: (relPath: string) => void;
  onCreateNewFile: () => void;
  onReloadPreview: () => void;
  onOpenPreviewInNewTab: () => void;
}

const DEV_MACROS = [
  { label: "git status", cmd: "git status --short" },
  { label: "tsc check", cmd: "npx tsc --noEmit" },
  { label: "npm test", cmd: "npm test" },
  { label: "npm i", cmd: "npm install" },
];

export default function RightPane({
  files,
  proposals,
  commands,
  previewSrc,
  logs,
  browserLogs,
  onClearBrowserLogs,
  onFixBrowserErrors,
  running,
  autoPreviewUrl,
  autoVerify,
  setAutoVerify,
  autoHeal,
  setAutoHeal,
  showPreview,
  setShowPreview,
  showTerminal,
  setShowTerminal,
  isDraggingGlobal,
  openTabs,
  activeTabPath,
  editorFocusSeq,
  setActiveTabPath,
  onUpdateTabContent,
  onSaveTab,
  onDeleteTabFile,
  onCloseTab,
  onPinFileToChat,
  onOpenReview,
  onApproveWrite,
  onRejectWrite,
  onApproveCommand,
  onRejectCommand,
  onApproveAll,
  onRunManualCommand,
  onFixErrors,
  onStopProcess,
  onRefreshLogs,
  onClearLogs,
  onCopyLogs,
  onInspectFile,
  onCreateNewFile,
  onReloadPreview,
  onOpenPreviewInNewTab,
}: RightPaneProps) {
  const rightPaneRef = useRef<HTMLDivElement>(null);
  const termOutputRef = useRef<HTMLPreElement>(null);
  const dockedLinesRef = useRef<HTMLPreElement>(null);
  const dockedTextareaRef = useRef<HTMLTextAreaElement>(null);

  const [upperMode, setUpperMode] = useState<"preview" | "editor">("preview");
  const [viewport, setViewport] = useState<"desktop" | "tablet" | "mobile">(
    "desktop"
  );
  const [termTab, setTermTab] = useState<"terminal" | "browser">("terminal");
  const [termHeightPx, setTermHeightPx] = useState<number>(260);
  const [isDraggingY, setIsDraggingY] = useState<boolean>(false);
  const [termMaximized, setTermMaximized] = useState<boolean>(false);
  const [previewMaximized, setPreviewMaximized] = useState<boolean>(false);
  const [termWrap, setTermWrap] = useState<boolean>(true);
  const [termAutoScroll] = useState<boolean>(true);
  const [termFilter, setTermFilter] = useState<string>("");
  const [fileSearch, setFileSearch] = useState<string>("");
  const [manualCmd, setManualCmd] = useState<string>("");
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [cmdHistIdx, setCmdHistIdx] = useState<number>(-1);

  // Switch to Docked Editor automatically when a tab is opened or focused from Explorer / Quick Bar / Ctrl+K
  useEffect(() => {
    if (activeTabPath) {
      setUpperMode("editor");
    }
  }, [activeTabPath, editorFocusSeq]);

  const activeTab = useMemo(
    () =>
      openTabs.find((t) => t.relPath === activeTabPath) || openTabs[0] || null,
    [openTabs, activeTabPath]
  );

  const dockedLineCount = useMemo(
    () => (activeTab ? Math.max(1, activeTab.content.split("\n").length) : 1),
    [activeTab]
  );
  const dockedLineGutter = useMemo(
    () => Array.from({ length: dockedLineCount }, (_, i) => i + 1).join("\n"),
    [dockedLineCount]
  );

  const propList = Object.values(proposals);
  const cmdList = Object.values(commands);

  let totalAdd = 0;
  let totalDel = 0;
  propList.forEach((p) => {
    totalAdd += p._add;
    totalDel += p._del;
  });

  useEffect(() => {
    if (termAutoScroll && termOutputRef.current) {
      termOutputRef.current.scrollTop = termOutputRef.current.scrollHeight;
    }
  }, [logs, browserLogs, termAutoScroll, termTab]);

  const startResizeY = () => {
    setIsDraggingY(true);
    const onMove = (e: MouseEvent) => {
      if (!rightPaneRef.current) return;
      const rect = rightPaneRef.current.getBoundingClientRect();
      const newH = rect.bottom - e.clientY;
      const maxH = rect.height - 80;
      if (newH >= 60 && newH <= maxH) {
        setTermHeightPx(newH);
      }
    };
    const onUp = () => {
      setIsDraggingY(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const filteredLogs = termFilter.trim()
    ? logs
        .split("\n")
        .filter((line) =>
          line.toLowerCase().includes(termFilter.trim().toLowerCase())
        )
        .join("\n")
    : logs;

  const visibleFiles = fileSearch.trim()
    ? files.filter((f) =>
        f.toLowerCase().includes(fileSearch.trim().toLowerCase())
      )
    : files;

  const browserErrorsCount = browserLogs.filter(
    (b) => b.level === "error"
  ).length;

  return (
    <div
      ref={rightPaneRef}
      className="flex-1 flex flex-col bg-slate-900 min-w-[260px] relative overflow-hidden"
    >
      {/* Approval Drawer */}
      {(propList.length > 0 || cmdList.length > 0) && (
        <div className="border-b border-amber-500/40 bg-amber-950/20 p-3 max-h-64 overflow-y-auto space-y-2 shrink-0">
          <div className="text-xs font-bold text-amber-400 flex flex-wrap items-center justify-between gap-2">
            <span>
              ⚠️ Waiting for you ·{" "}
              <span className="font-mono font-normal">
                {propList.length} file{propList.length === 1 ? "" : "s"} +
                {totalAdd} −{totalDel}
                {cmdList.length ? ` · ${cmdList.length} cmd` : ""}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <label
                className="flex items-center gap-1 text-[11px] font-normal text-slate-300 cursor-pointer"
                title="Automatically run npx tsc --noEmit after approving files to verify there are no TypeScript errors"
              >
                <input
                  type="checkbox"
                  checked={autoVerify}
                  onChange={(e) => setAutoVerify(e.target.checked)}
                  className="accent-emerald-500"
                />
                <span>🔄 Auto-Verify (`tsc`)</span>
              </label>
              <label
                className="flex items-center gap-1 text-[11px] font-normal text-indigo-300 cursor-pointer"
                title="When enabled with Auto-Verify, if npx tsc --noEmit fails after approval, automatically send the compiler errors to the AI once to self-heal"
              >
                <input
                  type="checkbox"
                  checked={autoHeal}
                  onChange={(e) => {
                    setAutoHeal(e.target.checked);
                    if (e.target.checked) setAutoVerify(true);
                  }}
                  className="accent-indigo-500"
                />
                <span>🤖 Auto-Heal (1-retry)</span>
              </label>
              <button
                onClick={() => onOpenReview()}
                className="bg-blue-600 hover:bg-blue-500 text-white px-2.5 py-1 rounded text-[11px]"
              >
                👀 Review changes
              </button>
              <button
                onClick={() => onApproveAll()}
                className="bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1 rounded text-[11px]"
              >
                ✅ Approve all &amp; run
              </button>
            </span>
          </div>
          <div className="space-y-1.5">
            {propList.map((p) => {
              const kind =
                p.kind === "delete"
                  ? "d"
                  : p.action.indexOf("CREATE") === 0
                    ? "a"
                    : "m";
              return (
                <div
                  key={p.id}
                  className="bg-slate-900 border border-slate-700 rounded-md px-2 py-1.5 text-xs flex items-center gap-2"
                >
                  <span className={`rv-badge ${kind}`}>
                    {kind.toUpperCase()}
                  </span>
                  {p.isCritical && (
                    <span
                      className="bg-rose-600/40 text-rose-200 border border-rose-500/50 px-1 rounded text-[9px] font-bold"
                      title={p.criticalReason || "Critical change"}
                    >
                      ⚠️ CRITICAL
                    </span>
                  )}
                  <span
                    onClick={() => onOpenReview(p.id)}
                    className="font-mono text-slate-100 truncate flex-1 cursor-pointer hover:underline"
                  >
                    {p.relPath}
                  </span>
                  <span className="font-mono whitespace-nowrap">
                    <span className="text-emerald-400">+{p._add}</span>
                    <span className="text-rose-400 ml-1">−{p._del}</span>
                  </span>
                  <button
                    onClick={() => onOpenReview(p.id)}
                    className="bg-slate-700 hover:bg-slate-600 px-2 py-0.5 rounded"
                  >
                    Review
                  </button>
                  <button
                    onClick={() => onApproveWrite(p.id)}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white px-2 py-0.5 rounded"
                    title="Approve"
                  >
                    ✅
                  </button>
                  <button
                    onClick={() => onRejectWrite(p.id)}
                    className="bg-rose-600/30 hover:bg-rose-600/50 text-rose-300 px-2 py-0.5 rounded"
                    title="Deny"
                  >
                    ❌
                  </button>
                </div>
              );
            })}
            {cmdList.map((c) => (
              <div
                key={c.id}
                className="bg-slate-900 border border-blue-500/40 rounded-md px-2 py-1.5 text-xs flex items-center gap-2"
              >
                <span>⚡</span>
                <code className="font-mono text-emerald-300 truncate flex-1">
                  {c.command}
                </code>
                <button
                  onClick={() => onApproveCommand(c.id)}
                  className="bg-blue-600 hover:bg-blue-500 text-white px-2 py-0.5 rounded"
                >
                  ▶ Run
                </button>
                <button
                  onClick={() => onRejectCommand(c.id)}
                  className="bg-rose-600/30 hover:bg-rose-600/50 text-rose-300 px-2 py-0.5 rounded"
                >
                  ❌
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Workspace Files Quick Bar */}
      <div className="border-b border-slate-800 p-1.5 flex gap-1.5 overflow-x-auto text-xs bg-slate-950 min-h-[38px] items-center shrink-0">
        {!showPreview && (
          <button
            onClick={() => {
              setShowPreview(true);
              setUpperMode("preview");
              onReloadPreview();
            }}
            className="bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-0.5 rounded font-semibold whitespace-nowrap shrink-0"
          >
            🚀 See App Preview
          </button>
        )}
        <button
          onClick={() => {
            setUpperMode("editor");
            onCreateNewFile();
          }}
          className="bg-emerald-600/20 hover:bg-emerald-600/40 border border-emerald-500/40 text-emerald-300 px-2 py-0.5 rounded font-mono whitespace-nowrap shrink-0"
          title="Create a new file in workspace"
        >
          + New File
        </button>
        {files.length > 5 && (
          <input
            type="text"
            value={fileSearch}
            onChange={(e) => setFileSearch(e.target.value)}
            placeholder="Find file…"
            className="bg-slate-900 border border-slate-700 rounded px-2 py-0.5 text-[11px] font-mono text-slate-200 w-28 shrink-0 focus:outline-none focus:border-emerald-500"
          />
        )}
        {visibleFiles.length === 0 ? (
          <span className="text-slate-500 italic px-2">
            {files.length === 0 ? "Folder is empty." : "No matching files."}
          </span>
        ) : (
          visibleFiles.map((f) => (
            <button
              key={f}
              onClick={() => {
                setUpperMode("editor");
                onInspectFile(f);
              }}
              title="Click to open in Studio Code Editor"
              className={`border px-2 py-0.5 rounded font-mono whitespace-nowrap transition-colors ${
                activeTabPath === f && upperMode === "editor"
                  ? "bg-emerald-950/60 border-emerald-500/60 text-emerald-200"
                  : "bg-slate-900 hover:bg-slate-800 border-slate-700 hover:border-emerald-500/50 text-slate-300"
              }`}
            >
              📄 {f}
            </button>
          ))
        )}
      </div>

      {/* UPPER WORKSPACE WINDOW: LIVE PREVIEW OR DOCKED MULTI-TAB CODE EDITOR */}
      {showPreview && (
        <div
          className={`${
            previewMaximized
              ? "fixed inset-0 z-30 bg-slate-950 flex flex-col"
              : "flex-1 flex flex-col min-h-[80px] relative"
          }`}
        >
          <div className="px-3 py-1 bg-slate-900 border-b border-slate-800 text-[11px] text-slate-400 font-mono flex flex-wrap items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-1.5">
              <div className="flex items-center bg-slate-950 border border-slate-800 rounded p-0.5 gap-0.5">
                <button
                  onClick={() => setUpperMode("preview")}
                  className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                    upperMode === "preview"
                      ? "bg-blue-600/30 text-blue-300 border border-blue-500/40"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  🌐 Live Preview
                </button>
                <button
                  onClick={() => setUpperMode("editor")}
                  className={`px-2 py-0.5 rounded text-[11px] font-semibold flex items-center gap-1 ${
                    upperMode === "editor"
                      ? "bg-emerald-600/30 text-emerald-300 border border-emerald-500/40"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <span>📝 Code Editor</span>
                  {openTabs.length > 0 && (
                    <span className="bg-slate-800 text-slate-200 px-1.5 rounded-full text-[9px]">
                      {openTabs.length}
                    </span>
                  )}
                </button>
              </div>

              {/* Responsive Viewport Presets when in Preview Mode */}
              {upperMode === "preview" && (
                <div className="hidden sm:flex items-center bg-slate-950 border border-slate-800 rounded p-0.5 gap-0.5 ml-1">
                  <button
                    onClick={() => setViewport("desktop")}
                    className={`px-1.5 py-0.5 rounded text-[10px] ${
                      viewport === "desktop"
                        ? "bg-slate-800 text-emerald-300"
                        : "text-slate-500 hover:text-slate-300"
                    }`}
                    title="Desktop Viewport (100%)"
                  >
                    🖥️ 100%
                  </button>
                  <button
                    onClick={() => setViewport("tablet")}
                    className={`px-1.5 py-0.5 rounded text-[10px] ${
                      viewport === "tablet"
                        ? "bg-slate-800 text-emerald-300"
                        : "text-slate-500 hover:text-slate-300"
                    }`}
                    title="Tablet Viewport (768px)"
                  >
                    💊 768px
                  </button>
                  <button
                    onClick={() => setViewport("mobile")}
                    className={`px-1.5 py-0.5 rounded text-[10px] ${
                      viewport === "mobile"
                        ? "bg-slate-800 text-emerald-300"
                        : "text-slate-500 hover:text-slate-300"
                    }`}
                    title="Mobile Viewport (375px)"
                  >
                    📱 375px
                  </button>
                </div>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              {upperMode === "preview" ? (
                <>
                  <button
                    onClick={onReloadPreview}
                    className="bg-slate-800 hover:bg-slate-700 text-emerald-300 px-2 py-0.5 rounded"
                    title="Reload preview"
                  >
                    ↻ Reload
                  </button>
                  <button
                    onClick={onOpenPreviewInNewTab}
                    className="bg-slate-800 hover:bg-slate-700 text-sky-300 px-2 py-0.5 rounded"
                    title="Open preview in a new browser tab"
                  >
                    ↗ Open in New Tab
                  </button>
                </>
              ) : (
                activeTab && (
                  <>
                    <button
                      onClick={() => onPinFileToChat(activeTab.relPath)}
                      className="bg-sky-600/30 hover:bg-sky-600/50 text-sky-200 border border-sky-500/40 px-2 py-0.5 rounded"
                      title="Pin @file to AI Chat"
                    >
                      📌 @Pin
                    </button>
                    {!activeTab.isNew && (
                      <button
                        onClick={() => onDeleteTabFile(activeTab.relPath)}
                        className="bg-rose-600/30 hover:bg-rose-600/50 text-rose-200 px-2 py-0.5 rounded"
                        title="Delete file from workspace"
                      >
                        🗑️ Delete
                      </button>
                    )}
                    <button
                      onClick={() => onSaveTab(activeTab.relPath)}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-0.5 rounded font-semibold"
                      title="Save file (Ctrl+S)"
                    >
                      💾 Save
                    </button>
                  </>
                )
              )}
              <button
                onClick={() => setPreviewMaximized(!previewMaximized)}
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-0.5 rounded"
              >
                {previewMaximized ? "🗗 Restore" : "🗖 Maximize"}
              </button>
              {!previewMaximized && (
                <button
                  onClick={() => setShowPreview(false)}
                  className="bg-slate-800 hover:bg-rose-900/50 text-slate-400 hover:text-rose-200 px-2 py-0.5 rounded"
                  title="Close Upper Window"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {upperMode === "preview" ? (
            <div className="flex-1 relative bg-slate-950 flex justify-center overflow-auto">
              {(isDraggingGlobal || isDraggingY) && (
                <div className="absolute inset-0 z-20 bg-transparent" />
              )}
              <div
                style={{
                  width:
                    viewport === "mobile"
                      ? "375px"
                      : viewport === "tablet"
                        ? "768px"
                        : "100%",
                }}
                className={`h-full bg-white transition-all duration-150 ${
                  viewport !== "desktop"
                    ? "border-x border-slate-700 shadow-2xl"
                    : "w-full"
                }`}
              >
                <iframe
                  src={previewSrc || "about:blank"}
                  referrerPolicy="no-referrer"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
                  className="w-full h-full border-0"
                />
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col overflow-hidden bg-slate-950">
              {/* Multi-Tab Bar */}
              {openTabs.length > 0 && (
                <div className="flex items-center bg-slate-900 border-b border-slate-800 overflow-x-auto shrink-0">
                  {openTabs.map((tab) => {
                    const isDirty = tab.content !== tab.originalContent;
                    const isActive =
                      (activeTab && activeTab.relPath === tab.relPath) || false;
                    return (
                      <div
                        key={tab.relPath}
                        onClick={() => setActiveTabPath(tab.relPath)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono border-r border-slate-800 cursor-pointer select-none shrink-0 ${
                          isActive
                            ? "bg-slate-950 text-emerald-300 border-b-2 border-b-emerald-400"
                            : "text-slate-400 hover:bg-slate-800/60"
                        }`}
                      >
                        <span>📄</span>
                        <span className="truncate max-w-[160px]">
                          {tab.relPath}
                        </span>
                        {isDirty && (
                          <span
                            className="text-amber-400 font-bold"
                            title="Unsaved changes"
                          >
                            •
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onCloseTab(tab.relPath);
                          }}
                          className="text-slate-500 hover:text-rose-300 ml-1 text-[10px]"
                          title="Close tab"
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {!activeTab ? (
                <div className="flex-1 flex items-center justify-center p-6 text-center text-xs text-slate-500 font-mono">
                  Click any file in the File Bar above or Explorer (`📂`) or press{" "}
                  <code className="text-emerald-400 mx-1">Ctrl+K</code> to open
                  files in the multi-tab code editor.
                </div>
              ) : (
                <div className="flex-1 flex overflow-hidden bg-slate-950">
                  <pre
                    ref={dockedLinesRef}
                    className="py-3 px-2.5 bg-slate-900/60 border-r border-slate-800 text-right font-mono text-xs text-slate-600 select-none overflow-hidden leading-relaxed m-0"
                  >
                    {dockedLineGutter}
                  </pre>
                  <textarea
                    ref={dockedTextareaRef}
                    value={activeTab.content}
                    onScroll={(e) => {
                      if (dockedLinesRef.current) {
                        dockedLinesRef.current.scrollTop =
                          e.currentTarget.scrollTop;
                      }
                    }}
                    onKeyDown={(e) => {
                      if (
                        (e.ctrlKey || e.metaKey) &&
                        e.key.toLowerCase() === "s"
                      ) {
                        e.preventDefault();
                        onSaveTab(activeTab.relPath);
                        return;
                      }
                      if (e.key === "Tab") {
                        e.preventDefault();
                        const start = e.currentTarget.selectionStart;
                        const end = e.currentTarget.selectionEnd;
                        const nextVal =
                          activeTab.content.substring(0, start) +
                          "  " +
                          activeTab.content.substring(end);
                        onUpdateTabContent(activeTab.relPath, nextVal);
                        requestAnimationFrame(() => {
                          if (dockedTextareaRef.current) {
                            dockedTextareaRef.current.selectionStart =
                              start + 2;
                            dockedTextareaRef.current.selectionEnd = start + 2;
                          }
                        });
                      }
                    }}
                    onChange={(e) =>
                      onUpdateTabContent(activeTab.relPath, e.target.value)
                    }
                    spellCheck={false}
                    className="flex-1 p-3 bg-slate-950 font-mono text-xs text-slate-200 focus:outline-none resize-none leading-relaxed whitespace-pre overflow-auto"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Vertical Resizer */}
      {showPreview && showTerminal && !termMaximized && !previewMaximized && (
        <div
          onMouseDown={startResizeY}
          className={`resizer-y shrink-0 ${isDraggingY ? "active" : ""}`}
          title="Drag to resize Preview and Terminal"
        />
      )}

      {/* SANDBOX TERMINAL + BROWSER CONSOLE WINDOW */}
      {showTerminal && (
        <div
          style={{
            height:
              termMaximized || !showPreview ? "100%" : `${termHeightPx}px`,
          }}
          className={`${
            termMaximized
              ? "fixed inset-0 z-30 bg-slate-950"
              : !showPreview
                ? "flex-1"
                : "shrink-0"
          } border-t border-slate-800 bg-slate-950 flex flex-col min-h-[60px]`}
        >
          {/* Terminal Toolbar */}
          <div className="px-3 py-1.5 bg-slate-900 border-b border-slate-800 text-[11px] text-slate-400 font-mono flex flex-wrap justify-between items-center gap-2 shrink-0">
            <div className="flex items-center gap-2">
              <div className="flex items-center bg-slate-950 border border-slate-800 rounded p-0.5 gap-0.5">
                <button
                  onClick={() => setTermTab("terminal")}
                  className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                    termTab === "terminal"
                      ? "bg-slate-800 text-emerald-300"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  💻 Server Terminal
                </button>
                <button
                  onClick={() => setTermTab("browser")}
                  className={`px-2 py-0.5 rounded text-[11px] font-semibold flex items-center gap-1 ${
                    termTab === "browser"
                      ? "bg-slate-800 text-sky-300"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <span>🌐 Browser Console</span>
                  {browserErrorsCount > 0 && (
                    <span className="bg-rose-600 text-white px-1.5 rounded-full text-[9px]">
                      {browserErrorsCount}
                    </span>
                  )}
                </button>
              </div>

              {running ? (
                <span className="text-emerald-400">
                  🟢 running{autoPreviewUrl ? ` · ${autoPreviewUrl}` : ""}
                </span>
              ) : (
                <span className="text-slate-500">⚪ idle</span>
              )}
              <div className="hidden lg:flex items-center gap-1 ml-1">
                {DEV_MACROS.map((m) => (
                  <button
                    key={m.label}
                    onClick={() => {
                      setTermTab("terminal");
                      onRunManualCommand(m.cmd);
                    }}
                    className="bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-1.5 py-0.5 rounded text-[10px]"
                    title={`Run: ${m.cmd}`}
                  >
                    ⚡ {m.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {termTab === "terminal" ? (
                <>
                  <input
                    type="text"
                    value={termFilter}
                    onChange={(e) => setTermFilter(e.target.value)}
                    placeholder="Filter logs…"
                    className="bg-slate-950 border border-slate-700 rounded px-2 py-0.5 text-[11px] text-slate-200 w-24 focus:outline-none focus:border-emerald-500"
                  />
                  <button
                    onClick={onRefreshLogs}
                    className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-0.5 rounded"
                    title="Refresh terminal logs"
                  >
                    ↻
                  </button>
                  <button
                    onClick={() => setTermWrap(!termWrap)}
                    className={`px-2 py-0.5 rounded ${
                      termWrap
                        ? "bg-slate-700 text-emerald-300"
                        : "bg-slate-800 text-slate-400"
                    }`}
                  >
                    Wrap
                  </button>
                  <button
                    onClick={onCopyLogs}
                    className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-0.5 rounded"
                  >
                    Copy
                  </button>
                  <button
                    onClick={onClearLogs}
                    className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-0.5 rounded"
                  >
                    Clear
                  </button>
                  <button
                    onClick={onFixErrors}
                    className="bg-amber-600/30 hover:bg-amber-600/50 text-amber-200 px-2 py-0.5 rounded"
                  >
                    🩹 Ask AI to fix
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={onClearBrowserLogs}
                    className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-0.5 rounded"
                  >
                    Clear Console
                  </button>
                  <button
                    onClick={onFixBrowserErrors}
                    className="bg-amber-600/30 hover:bg-amber-600/50 text-amber-200 px-2 py-0.5 rounded"
                  >
                    🩹 Fix Browser Errors with AI
                  </button>
                </>
              )}

              {running && (
                <button
                  onClick={onStopProcess}
                  className="bg-rose-600/30 hover:bg-rose-600/50 text-rose-200 px-2 py-0.5 rounded"
                >
                  ⏹ Stop
                </button>
              )}
              <button
                onClick={() => setTermMaximized(!termMaximized)}
                className="bg-slate-800 hover:bg-slate-700 text-slate-200 px-2 py-0.5 rounded"
              >
                {termMaximized ? "🗗 Restore" : "🗖 Fullscreen"}
              </button>
              {!termMaximized && (
                <button
                  onClick={() => setShowTerminal(false)}
                  className="bg-slate-800 hover:bg-rose-900/50 text-slate-400 hover:text-rose-200 px-2 py-0.5 rounded"
                  title="Close Terminal Window"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Output Area */}
          {termTab === "terminal" ? (
            <pre
              ref={termOutputRef}
              className={`flex-1 p-3 overflow-auto font-mono text-xs leading-relaxed text-slate-200 select-text ${
                termWrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"
              }`}
            >
              {filteredLogs || "Terminal output will appear here..."}
            </pre>
          ) : (
            <div className="flex-1 p-3 overflow-auto font-mono text-xs space-y-1.5">
              {browserLogs.length === 0 ? (
                <div className="text-slate-500 italic">
                  No browser console logs or runtime errors captured yet.
                </div>
              ) : (
                browserLogs.map((b) => (
                  <div
                    key={b.id}
                    className={`p-1.5 rounded border ${
                      b.level === "error"
                        ? "bg-rose-950/40 border-rose-500/40 text-rose-200"
                        : b.level === "warn"
                          ? "bg-amber-950/40 border-amber-500/40 text-amber-200"
                          : "bg-slate-900 border-slate-800 text-slate-300"
                    }`}
                  >
                    <span className="text-[10px] opacity-60 mr-2">
                      [{new Date(b.ts).toLocaleTimeString()}] [
                      {b.level.toUpperCase()}]
                    </span>
                    <span className="whitespace-pre-wrap break-words">
                      {b.text}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Interactive Sandbox Command Bar */}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!manualCmd.trim()) return;
              const cmd = manualCmd.trim();
              setCmdHistory((prev) => [cmd, ...prev.slice(0, 30)]);
              setCmdHistIdx(-1);
              setManualCmd("");
              setTermTab("terminal");
              await onRunManualCommand(cmd);
            }}
            className="border-t border-slate-800 bg-slate-900 px-3 py-1.5 flex items-center gap-2 shrink-0"
          >
            <span className="text-emerald-400 font-mono text-xs font-bold">
              $
            </span>
            <input
              type="text"
              value={manualCmd}
              onChange={(e) => setManualCmd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp" && cmdHistory.length > 0) {
                  e.preventDefault();
                  const next = Math.min(cmdHistIdx + 1, cmdHistory.length - 1);
                  setCmdHistIdx(next);
                  setManualCmd(cmdHistory[next]);
                } else if (e.key === "ArrowDown" && cmdHistIdx >= 0) {
                  e.preventDefault();
                  const next = cmdHistIdx - 1;
                  setCmdHistIdx(next);
                  setManualCmd(next >= 0 ? cmdHistory[next] : "");
                }
              }}
              placeholder="Run command in sandbox workspace (↑/↓ for history)..."
              className="flex-1 bg-transparent text-xs font-mono text-slate-100 focus:outline-none"
            />
            <button
              type="submit"
              className="bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-200 border border-emerald-500/40 px-2.5 py-0.5 rounded text-[11px] font-mono"
            >
              ▶ Run
            </button>
          </form>
        </div>
      )}
    </div>
  );
}