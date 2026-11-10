import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { getOrCreateSession } from "@/lib/session-store";
import { isSecretCredentialFile } from "@/lib/config";
import { isBinaryBuffer, walk } from "@/lib/workspace";
import type { SearchMatch } from "@/types/builder";

export async function GET(req: NextRequest) {
  const { session: s, error, status } = getOrCreateSession(
    req,
    undefined,
    true
  );
  if (!s) return NextResponse.json({ error }, { status: status || 400 });
  if (!s.root) {
    return NextResponse.json(
      { error: "Workspace not locked." },
      { status: 403 }
    );
  }

  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (!q) return NextResponse.json({ matches: [] });

  const qLower = q.toLowerCase();
  const { files } = walk(s.root);
  const matches: SearchMatch[] = [];

  outer: for (const f of files) {
    if (isSecretCredentialFile(f.rel)) continue;
    let content: string;
    try {
      const buf = fs.readFileSync(f.full);
      if (isBinaryBuffer(buf)) continue;
      content = buf.toString("utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(qLower)) {
        matches.push({
          relPath: f.rel,
          line: i + 1,
          snippet: lines[i].trim().slice(0, 180),
        });
        if (matches.length >= 120) break outer;
      }
    }
  }

  return NextResponse.json({ matches });
}