"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { computeDiff, markWords, type EnrichedProposal } from "@/lib/diff";
import type { CommandProposal, DiffOp } from "@/types/builder";

interface ReviewModalProps {
  open: boolean;
  selectedId: string | null;
  setSelectedId: (id: string) => void;
  proposals: Record<string, EnrichedProposal>;
  commands: Record<string, CommandProposal>;
  onClose: () => void;
  onApproveWrite: (
    id: string,
    force?: boolean,
    customContent?: string
  ) => Promise<boolean>;
  onRejectWrite: (id: string) => Promise<void>;
  onApproveCommand: (id: string) => Promise<unknown>;
  onRejectCommand: (id: string) => Promise<void>;
  onApproveFiles: (editedMap?: Record<string, string>) => Promise<boolean>;
  onApproveAll: (editedMap?: Record<string, string>) => Promise<void>;
  onDenyAll: () => Promise<void>;
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

export default function ReviewModal({
  open,
  selectedId,
  setSelectedId,
  proposals,
  commands,
  onClose,
  onApproveWrite,
  onRejectWrite,
  onApproveCommand,
  onRejectCommand,
  onApproveFiles,
  onApproveAll,
  onDenyAll,
}: ReviewModalProps) {
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [wrap, setWrap] = useState(true);
  const [viewed, setViewed] = useState<Record<string, boolean>>({});
  const [expandedMap, setExpandedMap] = useState<Record<string, number[]>>({});
  const [editingPropId, setEditingPropId] = useState<string | null>(null);
  const [editedContents, setEditedContents] = useState<Record<string, string>>(
    {}
  );

  const diffSectionRef = useRef<HTMLElement>(null);

  const propIds = Object.keys(proposals);
  const cmdList = Object.values(commands);

  // Scroll diff viewer back to top whenever the selected file changes
  useEffect(() => {
    if (diffSectionRef.current) {
      diffSectionRef.current.scrollTop = 0;
    }
    setEditingPropId(null);
  }, [selectedId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      const tag = (
        (e.target as HTMLElement | null)?.tagName || ""
      ).toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.key === "j" || e.key === "k") {
        if (!propIds.length) return;
        const dir = e.key === "j" ? 1 : -1;
        const curIdx = propIds.indexOf(selectedId || "");
        const nextIdx =
          curIdx < 0
            ? 0
            : Math.max(0, Math.min(propIds.length - 1, curIdx + dir));
        setSelectedId(propIds[nextIdx]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, propIds, selectedId, setSelectedId, onClose]);

  const rawActiveProp =
    selectedId && selectedId !== "cmds" && proposals[selectedId]
      ? proposals[selectedId]
      : Object.values(proposals)[0] || null;

  // Dynamically recompute diff ops if the user edited the proposal inline
  const activeProp = useMemo(() => {
    if (!rawActiveProp) return null;
    const custom = editedContents[rawActiveProp.id];
    if (custom === undefined || custom === rawActiveProp.content) {
      return rawActiveProp;
    }
    const ops = computeDiff(rawActiveProp.oldContent ?? null, custom);
    markWords(ops);
    let add = 0;
    let del = 0;
    ops.forEach((o) => {
      if (o.t === "+") add++;
      else if (o.t === "-") del++;
    });
    return {
      ...rawActiveProp,
      _ops: ops,
      _add: add,
      _del: del,
    };
  }, [rawActiveProp, editedContents]);

  if (!open) return null;

  const propList = Object.values(proposals);
  if (!propList.length && !cmdList.length) return null;

  const activeSel =
    selectedId === "cmds" && cmdList.length
      ? "cmds"
      : selectedId && proposals[selectedId]
        ? selectedId
        : propList.length
          ? propList[0].id
          : "cmds";

  const advanceSelection = (removingId: string) => {
    const idx = propIds.indexOf(removingId);
    const nextId = propIds[idx + 1] || propIds[idx - 1] || "cmds";
    setSelectedId(nextId);
  };

  let totalAdd = 0;
  let totalDel = 0;
  propList.forEach((p) => {
    totalAdd += p._add;
    totalDel += p._del;
  });

  const expandGap = (propId: string, gapStart: number) => {
    setExpandedMap((prev) => ({
      ...prev,
      [propId]: [...(prev[propId] || []), gapStart],
    }));
  };

  const expandedSet = new Set(activeProp ? expandedMap[activeProp.id] || [] : []);
  const isEditingCurrent =
    activeProp &&
    activeProp.kind === "write" &&
    editingPropId === activeProp.id;
  const currentDraft =
    activeProp && editedContents[activeProp.id] !== undefined
      ? editedContents[activeProp.id]
      : activeProp?.content ?? "";

  return (
    <div id="review" className="fixed inset-0 z-40 flex flex-col">
      <div className="rv-bar px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-sm">Review changes</span>
          <span className="text-xs text-slate-400 font-mono">
            {propList.length} file{propList.length === 1 ? "" : "s"} · +
            {totalAdd} −{totalDel}
            {cmdList.length
              ? ` · ${cmdList.length} command${cmdList.length === 1 ? "" : "s"}`
              : ""}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="seg">
            <button
              className={mode === "unified" ? "on" : ""}
              onClick={() => setMode("unified")}
            >
              Unified
            </button>
            <button
              className={mode === "split" ? "on" : ""}
              onClick={() => setMode("split")}
            >
              Split
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
            className="gbtn bad"
            onClick={async () => {
              setEditedContents({});
              await onDenyAll();
            }}
          >
            Deny all
          </button>
          <button
            className="gbtn ok"
            onClick={async () => {
              const ok = await onApproveFiles(editedContents);
              if (ok) setEditedContents({});
            }}
          >
            ✅ Approve all files
          </button>
          <button
            className="gbtn ok"
            onClick={async () => {
              await onApproveAll(editedContents);
              setEditedContents({});
            }}
          >
            ▶ Approve all &amp; run
          </button>
          <button className="gbtn" onClick={onClose}>
            ✕ Close
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <aside className="rv-aside">
          {propList.map((p) => {
            const kind =
              p.kind === "delete"
                ? "d"
                : p.action.indexOf("CREATE") === 0
                  ? "a"
                  : "m";
            const slash = p.relPath.lastIndexOf("/");
            const hasCustomEdit =
              editedContents[p.id] !== undefined &&
              editedContents[p.id] !== p.content;
            return (
              <div
                key={p.id}
                onClick={() => setSelectedId(p.id)}
                className={`rv-row ${activeSel === p.id ? "sel" : ""}`}
              >
                <span className={`rv-badge ${kind}`}>{kind.toUpperCase()}</span>
                {p.isCritical && (
                  <span
                    className="text-[10px] text-rose-400 font-bold"
                    title={p.criticalReason || "Critical change"}
                  >
                    ⚠️
                  </span>
                )}
                <div className="flex-1 min-w-0 truncate">
                  <span className="text-slate-500">
                    {slash >= 0 ? p.relPath.slice(0, slash + 1) : ""}
                  </span>
                  <span className="text-slate-100">
                    {p.relPath.slice(slash + 1)}
                  </span>
                  {hasCustomEdit && (
                    <span className="ml-1 text-[10px] text-sky-400">
                      (edited)
                    </span>
                  )}
                </div>
                <span className="text-[11px] whitespace-nowrap">
                  <span className="text-emerald-400">+{p._add}</span>
                  <span className="text-rose-400 ml-1">−{p._del}</span>
                </span>
                <input
                  type="checkbox"
                  checked={!!viewed[p.id]}
                  title="Mark as viewed"
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    setViewed((prev) => ({ ...prev, [p.id]: e.target.checked }))
                  }
                />
              </div>
            );
          })}
          {cmdList.length > 0 && (
            <div
              onClick={() => setSelectedId("cmds")}
              className={`rv-row ${activeSel === "cmds" ? "sel" : ""}`}
            >
              <span>⚡</span>
              <div className="flex-1">Commands ({cmdList.length})</div>
            </div>
          )}
        </aside>

        <section
          ref={diffSectionRef}
          className="flex-1 overflow-y-auto p-4 min-w-0"
        >
          {activeSel === "cmds" ? (
            <div>
              <div className="text-sm font-semibold mb-1">Terminal commands</div>
              <p className="text-xs text-slate-400 mb-3">
                These run inside your locked workspace, in order. Approve the
                file changes first if the commands depend on them.
              </p>
              {cmdList.map((c) => (
                <div
                  key={c.id}
                  className="border border-[#30363d] rounded-md p-3 mb-2 flex items-center justify-between gap-3 bg-[#161b22]"
                >
                  <code className="font-mono text-sm text-emerald-300 break-all">
                    $ {c.command}
                  </code>
                  <div className="flex gap-2 shrink-0">
                    <button
                      className="gbtn bad"
                      onClick={() => onRejectCommand(c.id)}
                    >
                      Deny
                    </button>
                    <button
                      className="gbtn ok"
                      onClick={() => onApproveCommand(c.id)}
                    >
                      ▶ Approve &amp; run
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : activeProp ? (
            <div>
              {activeProp.isCritical && (
                <div className="mb-2 text-xs text-rose-200 bg-rose-950/60 border border-rose-500/50 rounded-md px-3 py-2 flex items-center justify-between">
                  <span>
                    ⚠️ <b>Critical Change / Deletion Warning:</b>{" "}
                    {activeProp.criticalReason ||
                      "This operation modifies core project architecture or deletes a file."}
                  </span>
                  <span className="text-[11px] text-rose-300 font-mono">
                    Requires confirmation
                  </span>
                </div>
              )}
              <div className="rv-filehead">
                <div className="flex items-center min-w-0 text-sm">
                  <span className="font-mono truncate">
                    {activeProp.relPath}
                  </span>
                  <span className="ml-3 text-xs text-emerald-400 font-mono">
                    +{activeProp._add}
                  </span>
                  <span className="ml-1 text-xs text-rose-400 font-mono">
                    −{activeProp._del}
                  </span>
                  <span className="ml-3 text-[11px] text-slate-500">
                    {activeProp.action.toLowerCase()}
                  </span>
                </div>
                <div className="flex gap-2 shrink-0">
                  {activeProp.kind === "write" && (
                    <button
                      className="gbtn"
                      onClick={() => {
                        if (isEditingCurrent) {
                          setEditingPropId(null);
                        } else {
                          if (editedContents[activeProp.id] === undefined) {
                            setEditedContents((prev) => ({
                              ...prev,
                              [activeProp.id]: activeProp.content ?? "",
                            }));
                          }
                          setEditingPropId(activeProp.id);
                        }
                      }}
                      title="Tweak or edit the AI's proposed code before writing to disk"
                    >
                      {isEditingCurrent ? "👀 View Diff" : "✏️ Edit Proposal"}
                    </button>
                  )}
                  <button
                    className="gbtn bad"
                    onClick={async () => {
                      const targetId = activeProp.id;
                      advanceSelection(targetId);
                      setEditedContents((prev) => {
                        const copy = { ...prev };
                        delete copy[targetId];
                        return copy;
                      });
                      await onRejectWrite(targetId);
                    }}
                  >
                    Deny
                  </button>
                  <button
                    className="gbtn ok"
                    onClick={async () => {
                      const targetId = activeProp.id;
                      const custom = editedContents[targetId];
                      const ok = await onApproveWrite(targetId, false, custom);
                      if (ok) {
                        setEditedContents((prev) => {
                          const copy = { ...prev };
                          delete copy[targetId];
                          return copy;
                        });
                        advanceSelection(targetId);
                      }
                    }}
                  >
                    {activeProp.kind === "delete"
                      ? "🗑️ Confirm Delete"
                      : activeProp.isCritical
                        ? "⚠️ Confirm & Write"
                        : editedContents[activeProp.id] !== undefined &&
                            editedContents[activeProp.id] !== activeProp.content
                          ? "✅ Approve Edited File"
                          : "✅ Approve & write"}
                  </button>
                </div>
              </div>
              {activeProp.needsNewFolder && (
                <div className="text-xs text-amber-300 bg-amber-900/20 border border-amber-700/40 px-3 py-1.5">
                  📁 This will also create the folder:{" "}
                  {activeProp.folderToCreate}
                </div>
              )}
              <div className="rv-body">
                {isEditingCurrent ? (
                  <div className="p-3 bg-[#0d1117] space-y-2">
                    <div className="flex items-center justify-between text-xs text-sky-300 font-mono">
                      <span>
                        ✏️ Editing proposed content for {activeProp.relPath}{" "}
                        before saving to disk
                      </span>
                      {editedContents[activeProp.id] !== activeProp.content && (
                        <button
                          type="button"
                          onClick={() =>
                            setEditedContents((prev) => {
                              const copy = { ...prev };
                              delete copy[activeProp.id];
                              return copy;
                            })
                          }
                          className="text-rose-300 hover:underline"
                        >
                          Reset to AI proposal
                        </button>
                      )}
                    </div>
                    <textarea
                      value={currentDraft}
                      onChange={(e) =>
                        setEditedContents((prev) => ({
                          ...prev,
                          [activeProp.id]: e.target.value,
                        }))
                      }
                      spellCheck={false}
                      className="w-full h-[62vh] bg-slate-950 border border-slate-700 rounded p-3 font-mono text-xs text-slate-100 focus:outline-none focus:border-sky-500 leading-relaxed whitespace-pre"
                    />
                  </div>
                ) : !activeProp._ops ? (
                  <div className="p-4 text-sm text-slate-400">
                    Preview not available (existing file too large to diff).
                  </div>
                ) : !activeProp._ops.some((o) => o.t !== " ") ? (
                  <div className="p-4 text-sm text-slate-400">No changes.</div>
                ) : (
                  <table className={`gh ${wrap ? "" : "nowrap"}`}>
                    <tbody>
                      {mode === "unified"
                        ? visibleItems(activeProp._ops, expandedSet).map(
                            (it, idx) => {
                              if (it.kind === "gap") {
                                return (
                                  <tr
                                    key={`gap-${it.start}`}
                                    className="gap"
                                    onClick={() =>
                                      expandGap(activeProp.id, it.start)
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
                            visibleItems(activeProp._ops, expandedSet)
                          ).map((it, idx) => {
                            if (it.kind === "gap") {
                              return (
                                <tr
                                  key={`gap-${it.start}`}
                                  className="gap"
                                  onClick={() =>
                                    expandGap(activeProp.id, it.start)
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
                                  className={`num ${l && l.t === "-" ? "ndel" : l ? "" : "empty"}`}
                                >
                                  {l && l.o != null ? String(l.o) : ""}
                                </td>
                                {l ? (
                                  <td
                                    className={`code ${l.t === "-" ? "cdel" : ""}`}
                                  >
                                    <CodeContent op={l} />
                                  </td>
                                ) : (
                                  <td className="code empty" />
                                )}
                                <td
                                  className={`num sep ${r && r.t === "+" ? "nadd" : r ? "" : "empty"}`}
                                >
                                  {r && r.n != null ? String(r.n) : ""}
                                </td>
                                {r ? (
                                  <td
                                    className={`code ${r.t === "+" ? "cadd" : ""}`}
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
                )}
              </div>
            </div>
          ) : null}
        </section>
      </div>
      <div
        className="rv-bar px-4 py-1.5 text-[11px] text-slate-500"
        style={{ borderTop: "1px solid #30363d", borderBottom: 0 }}
      >
        Nothing is written to disk until you approve it · j / k = next /
        previous file · Esc = close
      </div>
    </div>
  );
}