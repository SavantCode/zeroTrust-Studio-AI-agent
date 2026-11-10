import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { sessions } from "@/lib/session-store";
import { loadSessionFromDisk } from "@/lib/disk-store";
import { safeResolve } from "@/lib/security";

const MIME_MAP: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".cjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

const CONSOLE_BRIDGE_SCRIPT = `<script>
(function(){
  function send(level, args) {
    try {
      var text = Array.prototype.slice.call(args).map(function(a){
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'object') { try { return JSON.stringify(a); } catch(e) { return String(a); } }
        return String(a);
      }).join(' ');
      window.parent.postMessage({ type: '__ZT_PREVIEW_CONSOLE__', level: level, text: text, ts: Date.now() }, '*');
    } catch(e) {}
  }
  var origErr = console.error, origWarn = console.warn, origLog = console.log;
  console.error = function(){ send('error', arguments); origErr.apply(console, arguments); };
  console.warn = function(){ send('warn', arguments); origWarn.apply(console, arguments); };
  console.log = function(){ send('log', arguments); origLog.apply(console, arguments); };
  window.addEventListener('error', function(e){
    send('error', [e.message + ' (' + (e.filename || 'inline') + ':' + (e.lineno || 0) + ')']);
  });
  window.addEventListener('unhandledrejection', function(e){
    send('error', ['Unhandled Promise Rejection:', e.reason]);
  });
})();
</script>`;

function statusHtmlPage(title: string, subtitle: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body {
    margin: 0;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #090d16;
    color: #94a3b8;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    text-align: center;
    padding: 24px;
    box-sizing: border-box;
  }
  .card {
    max-width: 440px;
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 12px;
    padding: 24px;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 15px;
    color: #e2e8f0;
  }
  p {
    margin: 0;
    font-size: 12px;
    line-height: 1.6;
  }
  code {
    color: #34d399;
    font-family: ui-monospace, Consolas, monospace;
    background: #020617;
    padding: 2px 6px;
    border-radius: 4px;
  }
</style>
</head>
<body>
  <div class="card">
    <h2>${title}</h2>
    <p>${subtitle}</p>
  </div>
</body>
</html>`;
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ sid: string; file?: string[] }> }
) {
  const { sid, file } = await context.params;
  let s = sessions.get(sid);
  if (!s && /^[0-9a-f-]{36}$/i.test(sid)) {
    const diskSession = loadSessionFromDisk(sid);
    if (diskSession) {
      s = diskSession;
      sessions.set(sid, s);
    }
  }

  if (!s || !s.root) {
    return new NextResponse(
      statusHtmlPage(
        "🔒 Workspace Not Locked",
        "Choose and lock a project folder to enable the live sandbox preview."
      ),
      {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  const relPath = file && file.length > 0 ? file.join("/") : "index.html";
  try {
    let { resolved, rel: cleanRel } = safeResolve(s, relPath);

    // Directory fallback to <dir>/index.html
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      const indexCandidate = safeResolve(
        s,
        `${relPath.replace(/\/+$/, "")}/index.html`
      );
      resolved = indexCandidate.resolved;
      cleanRel = indexCandidate.rel;
    }

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      if (relPath === "index.html") {
        return new NextResponse(
          statusHtmlPage(
            "🌐 Live Preview Ready",
            "No static <code>index.html</code> found in the workspace root. Build an HTML app or run your dev server (e.g. <code>npm run dev</code>) in the Sandbox Terminal below—the preview will automatically switch to your server URL."
          ),
          {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }
        );
      }
      return new NextResponse("File not found in workspace.", { status: 404 });
    }
    const ext = path.extname(resolved).toLowerCase();
    const contentType = MIME_MAP[ext] || "application/octet-stream";

    if (ext === ".html" || ext === ".htm") {
      let html = fs.readFileSync(resolved, "utf-8");
      const slashIdx = cleanRel.lastIndexOf("/");
      const baseDir = slashIdx >= 0 ? `${cleanRel.slice(0, slashIdx + 1)}` : "";
      const baseTag = /<base\s/i.test(html)
        ? ""
        : `<base href="/api/preview/${sid}/${baseDir}">`;

      // Rewrite root-relative asset paths (e.g. href="/style.css" or src="/app.js")
      // so static HTML previews resolve inside /api/preview/<sid>/ instead of 404ing on the Next.js root.
      html = html.replace(
        /\b(href|src)=["']\/(?!\/|api\/preview\/)([^"']+)["']/gi,
        `$1="/api/preview/${sid}/$2"`
      );

      if (/<head(\s[^>]*)?>/i.test(html)) {
        html = html.replace(
          /<head(\s[^>]*)?>/i,
          (match) => `${match}${baseTag}${CONSOLE_BRIDGE_SCRIPT}`
        );
      } else {
        html = baseTag + CONSOLE_BRIDGE_SCRIPT + html;
      }
      return new NextResponse(html, {
        headers: {
          "Content-Type": contentType,
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const buf = fs.readFileSync(resolved);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new NextResponse(msg, { status: 403 });
  }
}