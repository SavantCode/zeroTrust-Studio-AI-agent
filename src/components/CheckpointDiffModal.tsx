"use client";

import React, { useEffect, useMemo, useState } from "react";
import { computeDiff, markWords } from "@/lib/diff";
import type {
  CheckpointDiffFile,
  CheckpointSummary,
  DiffOp,
} from "@/types/builder";

interface CheckpointDiffModalProps {
  open: boolean;
  checkpoint: CheckpointSummary | null;
  diffs: CheckpointDiffFile[];
  onClose: () => void;
  onConfirmRestore: (id: string, name: string) => Promise<void>;
}

type VisibleItem =
  | { kind: "op"; op: DiffOp }
  | { kind: "gap"; start: number; count: number };

type SplitItem =
  | { kind: "gap"; start: number; count: number }
  | { kind: "pair"; l: DiffOp | null; r: DiffOp | null };

function visibleItems(ops: DiffOp[], expanded: Set<number>): VisibleItem[] {
  const n = ops.length;
  const show = new Array<boolean>(n).fill(false);
  ops.forEach((o, i) => {
    if (o.t !== " ") {
      for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) {
        show[k] = true;
      }
    }
  });
  const items: VisibleItem[] = [];
  let i = 0;
  while (i < n) {
    if (show[i]) {
      items.push({ kind: "op", op: ops[i] });
      i++;
    } else {
      let j = i;
      while (j < n && !show[j]) j++;
      if (expanded.has(i)) {
        for (let k = i; k < j; k++) items.push({ kind: "op", op: ops[k] });
      } else {
        items.push({ kind: "gap", start: i, count: j - i });
      }
      i = j;
    }
  }
  return items;
}

function splitRows(items: VisibleItem[]): SplitItem[] {
  const out: SplitItem[] = [];
  let k = 0;
  while (k < items.length) {
    const it = items[k];
    if (it.kind !== "op") {
      out.push(it);
      k++;
      continue;
    }
    if (it.op.t === " ") {
      out.push({ kind: "pair", l: it.op, r: it.op });
      k++;
      continue;
    }
    const dels: DiffOp[] = [];
    const adds: DiffOp[] = [];
    while (k < items.length) {
      const cur = items[k];
      if (cur.kind === "op" && cur.op.t === "-") {
        dels.push(cur.op);
        k++;
      } else break;
    }
    while (k < items.length) {
      const cur = items[k];
      if (cur.kind === "op" && cur.op.t === "+") {
        adds.push(cur.op);
        k++;
      } else break;
    }
    const m = Math.max(dels.length, adds.length);
    for (let i = 0; i < m; i++) {
      out.push({ kind: "pair", l: dels[i] || null, r: adds[i] || null });
    }
  }
  return out;
}

function CodeContent({ op }: { op: DiffOp }) {
  if (op.hl) {
    return (
      <>
        {op.s.slice(0, op.hl[0])}
        <span className={op.t === "+" ? "wa" : "wd"}>
          {op.s.slice(op.hl[0], op.hl[1])}
        </span>
        {op.s.slice(op.hl[1])}
      </>
    );
  }
  return <>{op.s === "" ? "\u200b" : op.s}</>;
}

export default function CheckpointDiffModal({
  open,
  checkpoint,
  diffs,
  onClose,
  onConfirmRestore,
}: CheckpointDiffModalProps) {
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [mode, setMode] = useState<"split" | "unified">("split");
  const [wrap, setWrap] = useState(true);
  const [expandedMap, setExpandedMap] = useState<Record<string, number[]>>({});
  const [restoring, setRestoring] = useState(false);

  const enriched = useMemo(() => {
    return diffs.map((d) => {
      const ops = computeDiff(d.currentContent, d.checkpointContent);
      markWords(ops);
      let add = 0;
      let del = 0;
      ops.forEach((o) => {
        if (o.t === "+") add++;
        else if (o.t === "-") del++;
      });
      return { ...d, ops, add, del };
    });
  }, [diffs]);

  useEffect(() => {
    if (enriched.length > 0) {
      setSelectedPath((prev) =>
        enriched.some((e) => e.relPath === prev) ? prev : enriched[0].relPath
      );
    } else {
      setSelectedPath("");
    }
  }, [enriched]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !checkpoint) return null;

  const activeFile =
    enriched.find((e) => e.relPath === selectedPath) || enriched[0] || null;
  const expandedSet = new Set(
    activeFile ? expandedMap[activeFile.relPath] || [] : []
  );

  let totalAdd = 0;
  let totalDel = 0;
  enriched.forEach((f) => {
    totalAdd += f.add;
    totalDel += f.del;
  });

  const expandGap = (relPath: string, gapStart: number) => {
    setExpandedMap((prev) => ({
      ...prev,
      [relPath]: [...(prev[relPath] || []), gapStart],
    }));
  };

  return (
    <div id="review" className="fixed inset-0 z-50 flex flex-col">
      <div className="rv-bar px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-sm text-amber-300">
            📌 Compare Checkpoint: &ldquo;{checkpoint.name}&rdquo;
          </span>
          <span className="text-xs text-slate-400 font-mono">
            {enriched.length} changed file{enriched.length === 1 ? "" : "s"} vs
            current workspace · +{totalAdd} −{totalDel}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="seg">
            <button
              className={mode === "split" ? "on" : ""}
              onClick={() => setMode("split")}
            >
              Split (Side-by-Side)
            </button>
            <button
              className={mode === "unified" ? "on" : ""}
              onClick={() => setMode("unified")}
            >
              Unified
            </button>
          </div>
          <label className="text-xs text-slate-300 flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={wrap}
              onChange={(e) => setWrap(e.target.checked)}
            />
            Wrap lines
          </label>
          <button
            disabled={restoring}
            className="gbtn ok"
            onClick={async () => {
              setRestoring(true);
              try {
                await onConfirmRestore(checkpoint.id, checkpoint.name);
                onClose();
              } finally {
                setRestoring(false);
              }
            }}
          >
            {restoring ? "Restoring…" : "⏪ Restore Checkpoint Now"}
          </button>
          <button className="gbtn" onClick={onClose}>
            ✕ Close
          </button>
        </div>
      </div>

      {enriched.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-8 text-center">
          <div className="max-w-md space-y-2">
            <div className="text-2xl">✅</div>
            <div className="text-sm font-semibold text-slate-200">
              Workspace is identical to Checkpoint &ldquo;{checkpoint.name}&rdquo;
            </div>
            <p className="text-xs text-slate-400">
              No files have been modified, added, or deleted since this
              checkpoint was saved.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden">
          <aside className="rv-aside">
            {enriched.map((f) => {
              const badge =
                f.status === "restore-create"
                  ? "a"
                  : f.status === "restore-delete"
                    ? "d"
                    : "m";
              const slash = f.relPath.lastIndexOf("/");
              return (
                <div
                  key={f.relPath}
                  onClick={() => setSelectedPath(f.relPath)}
                  className={`rv-row ${
                    activeFile?.relPath === f.relPath ? "sel" : ""
                  }`}
                >
                  <span className={`rv-badge ${badge}`}>
                    {badge.toUpperCase()}
                  </span>
                  <div className="flex-1 min-w-0 truncate">
                    <span className="text-slate-500">
                      {slash >= 0 ? f.relPath.slice(0, slash + 1) : ""}
                    </span>
                    <span className="text-slate-100">
                      {f.relPath.slice(slash + 1)}
                    </span>
                  </div>
                  <span className="text-[11px] whitespace-nowrap">
                    <span className="text-emerald-400">+{f.add}</span>
                    <span className="text-rose-400 ml-1">−{f.del}</span>
                  </span>
                </div>
              );
            })}
          </aside>

          <section className="flex-1 overflow-y-auto p-4 min-w-0">
            {activeFile && (
              <div>
                <div className="rv-filehead">
                  <div className="flex items-center min-w-0 text-sm">
                    <span className="font-mono truncate">
                      {activeFile.relPath}
                    </span>
                    <span className="ml-3 text-xs text-emerald-400 font-mono">
                      +{activeFile.add}
                    </span>
                    <span className="ml-1 text-xs text-rose-400 font-mono">
                      −{activeFile.del}
                    </span>
                    <span className="ml-3 text-[11px] text-slate-400">
                      {activeFile.status === "restore-create"
                        ? "will be re-created from checkpoint"
                        : activeFile.status === "restore-delete"
                          ? "created after checkpoint (will be removed)"
                          : "Left: Current Disk · Right: Checkpoint State"}
                    </span>
                  </div>
                </div>
                <div className="rv-body">
                  <table className={`gh ${wrap ? "" : "nowrap"}`}>
                    <tbody>
                      {mode === "unified"
                        ? visibleItems(activeFile.ops, expandedSet).map(
                            (it, idx) => {
                              if (it.kind === "gap") {
                                return (
                                  <tr
                                    key={`gap-${it.start}`}
                                    className="gap"
                                    onClick={() =>
                                      expandGap(activeFile.relPath, it.start)
                                    }
                                  >
                                    <td colSpan={4}>
                                      ↕ Expand {it.count} unchanged line
                                      {it.count === 1 ? "" : "s"}
                                    </td>
                                  </tr>
                                );
                              }
                              const op = it.op;
                              const rowCls =
                                op.t === "+"
                                  ? "add"
                                  : op.t === "-"
                                    ? "del"
                                    : "";
                              return (
                                <tr key={idx} className={rowCls}>
                                  <td className="num">
                                    {op.o == null ? "" : String(op.o)}
                                  </td>
                                  <td className="num">
                                    {op.n == null ? "" : String(op.n)}
                                  </td>
                                  <td className="sign">
                                    {op.t === " " ? "" : op.t}
                                  </td>
                                  <td className="code">
                                    <CodeContent op={op} />
                                  </td>
                                </tr>
                              );
                            }
                          )
                        : splitRows(
                            visibleItems(activeFile.ops, expandedSet)
                          ).map((it, idx) => {
                            if (it.kind === "gap") {
                              return (
                                <tr
                                  key={`gap-${it.start}`}
                                  className="gap"
                                  onClick={() =>
                                    expandGap(activeFile.relPath, it.start)
                                  }
                                >
                                  <td colSpan={4}>
                                    ↕ Expand {it.count} unchanged line
                                    {it.count === 1 ? "" : "s"}
                                  </td>
                                </tr>
                              );
                            }
                            const { l, r } = it;
                            return (
                              <tr key={idx}>
                                <td
                                  className={`num ${
                                    l && l.t === "-"
                                      ? "ndel"
                                      : l
                                        ? ""
                                        : "empty"
                                  }`}
                                >
                                  {l && l.o != null ? String(l.o) : ""}
                                </td>
                                {l ? (
                                  <td
                                    className={`code ${
                                      l.t === "-" ? "cdel" : ""
                                    }`}
                                  >
                                    <CodeContent op={l} />
                                  </td>
                                ) : (
                                  <td className="code empty" />
                                )}
                                <td
                                  className={`num sep ${
                                    r && r.t === "+"
                                      ? "nadd"
                                      : r
                                        ? ""
                                        : "empty"
                                  }`}
                                >
                                  {r && r.n != null ? String(r.n) : ""}
                                </td>
                                {r ? (
                                  <td
                                    className={`code ${
                                      r.t === "+" ? "cadd" : ""
                                    }`}
                                  >
                                    <CodeContent op={r} />
                                  </td>
                                ) : (
                                  <td className="code empty" />
                                )}
                              </tr>
                            );
                          })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}