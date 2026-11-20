# 🔐 Case Study 02: Vertex AI Authentication, OpenSSL 3 PEM Decoding, DNS Resilience & Undici `"terminated"` Stream Recovery

## Overview
When connecting a local Next.js + Node.js (`v18+` / `v22`) application to **Google Cloud Vertex AI** (`@google/genai` + `google-auth-library`) for long-running code generation streams, three runtime failures can interrupt requests:

1. **Cryptographic Layer Failure**: `error:1E08010C:DECODER routines::unsupported` when signing the OAuth2 JWT with `GOOGLE_PRIVATE_KEY`.
2. **Network / DNS Layer Failure**: `request to https://oauth2.googleapis.com/token failed, reason: getaddrinfo ENOTFOUND oauth2.googleapis.com` when exchanging the signed JWT for a Bearer access token.
3. **Long-Stream Undici Socket Termination (~60s–90s)**: `TypeError: terminated` thrown by Node's built-in Undici `fetch` engine mid-response during heavy multi-file generation or extended reasoning (`thought`) phases.

This case study explains the root cause of all three issues and the self-healing defenses built into `src/lib/config.ts`, `src/app/api/auth-status/route.ts`, `src/app/api/chat/route.ts`, and `src/components/HeaderBar.tsx`.

---

## Architecture of the Vertex AI OAuth2 & Resilient Stream Pipeline

```mermaid
sequenceDiagram
    participant Env as .env / vertex_credentials.json
    participant Config as src/lib/config.ts (OpenSSL 3 + DNS)
    participant ChatAPI as src/app/api/chat/route.ts
    participant OAuthDNS as oauth2.googleapis.com
    participant Vertex as Vertex AI Gemini Stream

    Env->>Config: Load GOOGLE_PRIVATE_KEY & GOOGLE_CLIENT_EMAIL
    Config->>Config: 1. Canonicalize 64-char PKCS#8 PEM & self-test RSA-SHA256
    Config->>Config: 2. Set dns.setDefaultResultOrder("ipv4first")
    ChatAPI->>OAuthDNS: Exchange signed JWT (with 3x backoff retry)
    OAuthDNS-->>ChatAPI: OAuth2 Bearer Token
    ChatAPI->>Vertex: Open generateContentStream() + 15s Heartbeat
    Note over ChatAPI,Vertex: If Undici throws TypeError: terminated at ~90s mid-stream:
    Vertex--xChatAPI: TypeError: terminated (after partial text streamed)
    ChatAPI->>ChatAPI: 3. Catch mid-stream drop -> mark finishReason = "INTERRUPTED"
    ChatAPI->>Vertex: 4. Auto-Continue from exact <<<TAIL_END>>> with fresh client pool
    Vertex-->>ChatAPI: Stream remaining files & stitch seamlessly
```

---

## Challenge 1: `error:1E08010C:DECODER routines::unsupported` (OpenSSL 3 PEM Strictness)

### Root Cause
Node.js `v17+` (including `v20` and `v22`) upgraded its underlying TLS/crypto engine to **OpenSSL 3.0+**, which enforces strict RFC 7468 PEM framing rules. When developers copy `private_key` from a Google Cloud Service Account `.json` file into a `.env` file, subtle formatting corruptions commonly occur:
- Trailing JSON commas copied at the end of the line (`"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",`).
- Double-escaped newlines (`\\n` or `\r\n`) or spaces replacing newlines when pasted into single-line `.env` editors.
- Missing 64-character line wrapping between the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` headers.
- Unbalanced surrounding quotes (`"` or `'`).

When `google-auth-library` calls `crypto.createSign('RSA-SHA256').sign(privateKey)` on a slightly malformed PEM string, OpenSSL 3 throws:
```text
Error: error:1E08010C:DECODER routines::unsupported
```

### Engineering Solution (`validateAndCanonicalizePrivateKey` in `src/lib/config.ts`)
Instead of passing the raw `.env` string directly to `google-auth-library`, we built a deterministic PEM canonicalizer and self-test pipeline:
1. **Quote, Comma & Escape Normalization**: Strips surrounding quotes, trailing commas/semicolons, and converts any `\\r\\n` or `\\n` sequences into real `\n` line breaks.
2. **Base64 Body Extraction & 64-Char RFC 7468 Reconstruction**: If the fast-path parse fails, regex extracts the pure base64 payload between `-----BEGIN ... PRIVATE KEY-----` and `-----END ... PRIVATE KEY-----`, strips stray non-base64 characters, repairs base64 `=` padding if needed, and chunks the body into strict 64-character lines.
3. **Real OpenSSL 3 PKCS#8 Export + `RSA-SHA256` Signature Self-Test**:
   - Calls `crypto.createPrivateKey({ key: candidate, format: "pem" })`.
   - Exports a clean, canonical PKCS#8 PEM string via `keyObj.export({ type: "pkcs8", format: "pem" })`.
   - Executes a real `crypto.sign("RSA-SHA256", Buffer.from("vertex-jwt-self-test"), keyObj)` verification before the key is ever handed to Vertex AI.

---

## Challenge 2: `getaddrinfo ENOTFOUND oauth2.googleapis.com` (OAuth2 Token Exchange DNS Failure)

### Root Cause
The error:
```text
request to https://oauth2.googleapis.com/token failed, reason: getaddrinfo ENOTFOUND oauth2.googleapis.com
```
occurs **after** the RSA private key has already succeeded locally, when `google-auth-library` makes an outbound HTTPS POST request to `https://oauth2.googleapis.com/token` and Node's `libuv` calls OS DNS resolution (`uv_getaddrinfo`):
- **Node.js `v18+`/`v22` Dual-Stack IPv6-First (`verbatim`) DNS Resolution**: Many Windows machines and ISP routers fail or drop `getaddrinfo` queries when IPv6 (`AAAA`) is queried before IPv4 (`A`).
- **Transient Wi-Fi / Router DNS Blips**: Local DNS resolvers occasionally drop a single UDP packet; `google-auth-library` does not retry `ENOTFOUND` by default.
- **Malformed `GOOGLE_TOKEN_URI` in `.env`**: Accidental quotes or spaces in `GOOGLE_TOKEN_URI`.

### Engineering Solution
1. **IPv4-First DNS Ordering (`src/lib/config.ts`)**: `dns.setDefaultResultOrder("ipv4first")` forces Node.js `getaddrinfo` to prioritize IPv4 (`A`) records.
2. **`sanitizeHttpsUrl()` Validation (`src/lib/config.ts`)**: Validates `GOOGLE_TOKEN_URI` via `new URL()` and falls back to `https://oauth2.googleapis.com/token`.
3. **Live DNS Reachability Probe (`src/app/api/auth-status/route.ts` & `src/components/HeaderBar.tsx`)**: `checkVertexDnsReachability()` verifies `oauth2.googleapis.com` resolution and displays the resolved IP inside the `🔑` top-bar popover.

---

## Challenge 3: `TypeError: terminated` Mid-Stream Cutoff at ~90 Seconds (`POST /api/chat 200 in 90623ms`)

### Root Cause
In Node.js `v18+` / `v22`, global `fetch()` is powered by **Undici**. During long-running LLM generations (`60s–90s+`) or extended internal reasoning (`part.thought === true`) phases:
1. Google's Vertex AI SSE gateway or Undici's socket pool may close or time out the underlying HTTP connection mid-stream, throwing `TypeError: terminated` (`err.message === "terminated"`).
2. Previously:
   - `"terminated"` was not in the transient retry regex.
   - `runStreamPass()` only triggered `"INTERRUPTED"` recovery if `passText.length > 200`.
   - Continuation passes (`Pass 1..5`) inside the auto-continuation loop were not wrapped in their own `try/catch`, so a `"terminated"` error on a continuation pass jumped to the outer `catch` block and discarded the entire 90-second response!

### Engineering Solution (`src/app/api/chat/route.ts`)
1. **Zero-Loss Partial Stream Recovery (`passText.trim().length > 0`)**:
   - Whenever `generateContentStream` throws mid-stream after emitting **any** visible text (`passText.trim().length > 0`), `runStreamPass()` catches the error, refreshes the `GoogleGenAI` client pool, and returns `{ text: passText, finishReason: "INTERRUPTED", interruptedByError: true }` instead of throwing.
   - The **Tail-Append Auto-Continuation Engine** immediately takes the last `1,200` characters (`<<<TAIL_START>>>...<<<TAIL_END>>>`) and seamlessly resumes the response from the exact character where Undici terminated!
2. **Pre-Text Thinking Phase Retry (`TRANSIENT_STREAM_ERROR_RE`)**:
   - Added `terminated`, `UND_ERR_`, `other side closed`, `502/503/504`, `UNAVAILABLE`, and `DEADLINE_EXCEEDED` to `TRANSIENT_STREAM_ERROR_RE`. If a stream terminates before any visible text is emitted (e.g., during internal model thinking), `runStreamPass()` recreates the Vertex client and retries up to 3 times with backoff.
3. **Fault-Tolerant Continuation Loop (Up to 8 Passes) & 15s Stream Heartbeat**:
   - Wrapped continuation passes in an inner `try/catch` so if a late continuation pass fails repeatedly, the server gracefully finalizes and commits all content and file proposals already generated rather than aborting the turn.
   - Added a 15-second `{ t: "hb" }` keep-alive heartbeat over the NDJSON stream.

---

## Summary Table for Technical Interviews

| Failure Signature | Layer | Root Cause | Solution Implemented |
| :--- | :--- | :--- | :--- |
| `error:1E08010C:DECODER routines::unsupported` | Local Crypto (OpenSSL 3) | `.env` private key had escaped `\\n`, trailing commas, or non-64-char PEM framing | `validateAndCanonicalizePrivateKey()` reconstructs strict 64-char PKCS#8 PEM & self-tests `crypto.sign("RSA-SHA256")` |
| `getaddrinfo ENOTFOUND oauth2.googleapis.com` | Network / OS DNS (`libuv`) | Windows/Node IPv6-first DNS lookup failure, transient router DNS drop, or offline/VPN block | `dns.setDefaultResultOrder("ipv4first")`, `sanitizeHttpsUrl()`, 3x exponential backoff retry, and live DNS health check in UI |
| `terminated` (`POST /api/chat 200 in 90623ms`) | HTTP/2 SSE Stream (Node Undici) | Undici / Vertex SSE gateway closing long-running stream (~90s) during heavy output or thinking phase | Any partial `passText` returns `finishReason: "INTERRUPTED"` ->无缝 auto-continues from `<<<TAIL_END>>>`, retries `terminated` with fresh client pool, and sends 15s keep-alive heartbeats |