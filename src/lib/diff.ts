import type { DiffOp, FileProposal } from "@/types/builder";

export interface EnrichedProposal extends FileProposal {
  _ops: DiffOp[] | null;
  _add: number;
  _del: number;
}

function lines(s: string): string[] {
  const a = s.split("\n");
  if (a.length && a[a.length - 1] === "") a.pop();
  return a;
}

export function computeDiff(a: string | null, b: string | null): DiffOp[] {
  const A = a == null ? [] : lines(a);
  const B = b == null ? [] : lines(b);
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let e = 0;
  while (
    e < A.length - p &&
    e < B.length - p &&
    A[A.length - 1 - e] === B[B.length - 1 - e]
  ) {
    e++;
  }
  const a2 = A.slice(p, A.length - e);
  const b2 = B.slice(p, B.length - e);
  const n = a2.length;
  const m = b2.length;
  const mid: Array<[" " | "+" | "-", string]> = [];

  if (n * m <= 4_000_000) {
    const w = m + 1;
    const use32 = Math.min(n, m) >= 65535;
    const dp = use32
      ? new Uint32Array((n + 1) * w)
      : new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] =
          a2[i] === b2[j]
            ? dp[(i + 1) * w + j + 1] + 1
            : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    let dels: string[] = [];
    let adds: string[] = [];
    const flush = () => {
      dels.forEach((x) => mid.push(["-", x]));
      adds.forEach((x) => mid.push(["+", x]));
      dels = [];
      adds = [];
    };
    while (i < n && j < m) {
      if (a2[i] === b2[j]) {
        flush();
        mid.push([" ", a2[i]]);
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        dels.push(a2[i]);
        i++;
      } else {
        adds.push(b2[j]);
        j++;
      }
    }
    while (i < n) dels.push(a2[i++]);
    while (j < m) adds.push(b2[j++]);
    flush();
  } else {
    a2.forEach((x) => mid.push(["-", x]));
    b2.forEach((x) => mid.push(["+", x]));
  }

  const ops: DiffOp[] = [];
  let o = 1;
  let nn = 1;
  for (let i = 0; i < p; i++) ops.push({ t: " ", s: A[i], o: o++, n: nn++ });
  mid.forEach((x) => {
    if (x[0] === " ") ops.push({ t: " ", s: x[1], o: o++, n: nn++ });
    else if (x[0] === "-") ops.push({ t: "-", s: x[1], o: o++, n: null });
    else ops.push({ t: "+", s: x[1], o: null, n: nn++ });
  });
  for (let i = 0; i < e; i++) {
    ops.push({ t: " ", s: A[A.length - e + i], o: o++, n: nn++ });
  }

  // Handle EOF trailing newline-only difference so ReviewModal never shows "No changes."
  if (
    a !== null &&
    b !== null &&
    a !== b &&
    !ops.some((op) => op.t !== " ")
  ) {
    const aEndsNl = a.endsWith("\n");
    const bEndsNl = b.endsWith("\n");
    if (aEndsNl !== bEndsNl) {
      ops.push({
        t: bEndsNl ? "+" : "-",
        s: bEndsNl
          ? "[EOF trailing newline added]"
          : "[EOF trailing newline removed]",
        o: bEndsNl ? null : o,
        n: bEndsNl ? nn : null,
      });
    }
  }

  return ops;
}

export function markWords(ops: DiffOp[]): void {
  let i = 0;
  while (i < ops.length) {
    if (ops[i].t === "-") {
      const d = i;
      while (i < ops.length && ops[i].t === "-") i++;
      const a = i;
      while (i < ops.length && ops[i].t === "+") i++;
      const k = Math.min(a - d, i - a);
      for (let q = 0; q < k; q++) {
        const x = ops[d + q];
        const y = ops[a + q];
        let p = 0;
        while (p < x.s.length && p < y.s.length && x.s[p] === y.s[p]) p++;
        let e = 0;
        while (
          e < x.s.length - p &&
          e < y.s.length - p &&
          x.s[x.s.length - 1 - e] === y.s[y.s.length - 1 - e]
        ) {
          e++;
        }
        if (
          p + e >= 0.3 * Math.max(x.s.length, y.s.length) &&
          x.s.length < 600
        ) {
          x.hl = [p, x.s.length - e];
          y.hl = [p, y.s.length - e];
        }
      }
    } else {
      i++;
    }
  }
}

export function enrichProposal(p: FileProposal): EnrichedProposal {
  let ops: DiffOp[] | null = null;
  if (p.kind === "delete") {
    ops = p.oldContent != null ? computeDiff(p.oldContent, null) : null;
  } else if (p.action.indexOf("OVERWRITE") === 0 && p.oldContent == null) {
    ops = null;
  } else {
    ops = computeDiff(p.oldContent ?? null, p.content ?? "");
  }

  let add = 0;
  let del = 0;
  if (ops) {
    markWords(ops);
    ops.forEach((x) => {
      if (x.t === "+") add++;
      else if (x.t === "-") del++;
    });
  }
  return {
    ...p,
    _ops: ops,
    _add: add,
    _del: del,
  };
}