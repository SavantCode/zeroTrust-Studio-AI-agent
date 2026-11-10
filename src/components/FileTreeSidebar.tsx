"use client";

import React, { useMemo, useState } from "react";
import type { SearchMatch } from "@/types/builder";

interface FileTreeSidebarProps {
  files: string[];
  onSelectFile: (relPath: string) => void;
  onPinFile: (relPath: string) => void;
  onCreateNewFile: () => void;
  onSearchFiles: (query: string) => Promise<SearchMatch[]>;
  onClose: () => void;
}

interface TreeNode {
  name: string;
  path: string;
  isFolder: boolean;
  children: Record<string, TreeNode>;
}

function buildTree(files: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isFolder: true, children: {} };
  for (const file of files) {
    const parts = file.split("/");
    let cur = root;
    let curPath = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      curPath = curPath ? `${curPath}/${part}` : part;
      const isLast = i === parts.length - 1;
      if (!cur.children[part]) {
        cur.children[part] = {
          name: part,
          path: curPath,
          isFolder: !isLast,
          children: {},
        };
      }
      cur = cur.children[part];
    }
  }
  return root;
}

export default function FileTreeSidebar({
  files,
  onSelectFile,
  onPinFile,
  onCreateNewFile,
  onSearchFiles,
  onClose,
}: FileTreeSidebarProps) {
  const [tab, setTab] = useState<"tree" | "search">("tree");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [filterText, setFilterText] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchMatch[]>([]);

  const filteredFiles = useMemo(() => {
    if (!filterText.trim()) return files;
    const q = filterText.trim().toLowerCase();
    return files.filter((f) => f.toLowerCase().includes(q));
  }, [files, filterText]);

  const tree = useMemo(() => buildTree(filteredFiles), [filteredFiles]);

  const toggleFolder = (path: string) => {
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const m = await onSearchFiles(searchQuery.trim());
      setResults(m);
    } finally {
      setSearching(false);
    }
  };

  const renderNode = (node: TreeNode, depth = 0): React.ReactNode => {
    const entries = Object.values(node.children).sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return entries.map((child) => {
      if (child.isFolder) {
        const isClosed = !!collapsed[child.path];
        return (
          <div key={child.path}>
            <div
              onClick={() => toggleFolder(child.path)}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              className="flex items-center gap-1.5 py-1 pr-2 text-xs font-mono text-slate-300 hover:bg-slate-800/70 cursor-pointer select-none"
            >
              <span className="text-[10px] text-slate-500">
                {isClosed ? "▶" : "▼"}
              </span>
              <span className="text-amber-400/90">📁</span>
              <span className="truncate">{child.name}</span>
            </div>
            {!isClosed && renderNode(child, depth + 1)}
          </div>
        );
      }

      return (
        <div
          key={child.path}
          style={{ paddingLeft: `${depth * 12 + 18}px` }}
          className="group flex items-center justify-between gap-1 py-1 pr-2 text-xs font-mono text-slate-300 hover:bg-slate-800 cursor-pointer"
          onClick={() => onSelectFile(child.path)}
        >
          <span className="flex items-center gap-1.5 min-w-0 truncate">
            <span className="text-slate-500">📄</span>
            <span className="truncate">{child.name}</span>
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPinFile(child.path);
            }}
            title={`Pin @${child.path} to chat`}
            className="opacity-0 group-hover:opacity-100 text-[10px] bg-sky-900/60 hover:bg-sky-700 text-sky-200 px-1.5 rounded shrink-0"
          >
            @Pin
          </button>
        </div>
      );
    });
  };

  return (
    <aside className="w-60 border-r border-slate-800 bg-slate-950 flex flex-col shrink-0 select-none">
      <div className="px-2.5 py-1.5 bg-slate-900 border-b border-slate-800 flex items-center justify-between text-xs">
        <div className="flex gap-1">
          <button
            onClick={() => setTab("tree")}
            className={`px-2 py-0.5 rounded text-[11px] font-medium ${
              tab === "tree"
                ? "bg-slate-800 text-emerald-300"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            📂 Files ({files.length})
          </button>
          <button
            onClick={() => setTab("search")}
            className={`px-2 py-0.5 rounded text-[11px] font-medium ${
              tab === "search"
                ? "bg-slate-800 text-emerald-300"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            🔍 Search
          </button>
        </div>
        <button
          onClick={onClose}
          className="text-slate-500 hover:text-slate-300 text-xs px-1"
          title="Close Explorer Sidebar"
        >
          ✕
        </button>
      </div>

      {tab === "tree" ? (
        <>
          <div className="p-2 border-b border-slate-800 flex gap-1.5">
            <input
              type="text"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="Filter files…"
              className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[11px] font-mono text-slate-200 focus:outline-none focus:border-emerald-500"
            />
            <button
              onClick={onCreateNewFile}
              className="bg-emerald-600/30 hover:bg-emerald-600/50 border border-emerald-500/40 text-emerald-200 px-2 py-1 rounded text-[11px] font-mono shrink-0"
              title="Create new file"
            >
              +
            </button>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {files.length === 0 ? (
              <div className="p-4 text-xs text-slate-500 italic">
                Workspace is empty.
              </div>
            ) : (
              renderNode(tree)
            )}
          </div>
        </>
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden">
          <form
            onSubmit={handleSearch}
            className="p-2 border-b border-slate-800 flex gap-1.5"
          >
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search inside code…"
              className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[11px] font-mono text-slate-200 focus:outline-none focus:border-emerald-500"
            />
            <button
              type="submit"
              disabled={searching}
              className="bg-blue-600 hover:bg-blue-500 text-white px-2 py-1 rounded text-[11px]"
            >
              Go
            </button>
          </form>
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {searching ? (
              <div className="text-xs text-slate-400 animate-pulse">
                Searching workspace…
              </div>
            ) : results.length === 0 ? (
              <div className="text-xs text-slate-500">
                Enter a keyword to search across all files.
              </div>
            ) : (
              results.map((r, i) => (
                <div
                  key={`${r.relPath}-${r.line}-${i}`}
                  onClick={() => onSelectFile(r.relPath)}
                  className="bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded p-1.5 cursor-pointer"
                >
                  <div className="text-[11px] font-mono text-emerald-400 flex justify-between">
                    <span className="truncate">{r.relPath}</span>
                    <span className="text-slate-500 shrink-0">:{r.line}</span>
                  </div>
                  <div className="text-[10px] font-mono text-slate-300 truncate mt-0.5">
                    {r.snippet}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </aside>
  );
}