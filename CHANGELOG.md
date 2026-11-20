## v3.4.0 — Fix Mid-Stream `TypeError: terminated` Cutoff (~90s) via Seamless Auto-Continuation & Stream Heartbeats

### What Changed
1. **Zero-Loss Mid-Stream `terminated` Recovery (`src/app/api/chat/route.ts`)**:
   - Fixed the issue where long-running Vertex AI streams (~60–90s) that threw Node Undici's `TypeError: terminated` aborted the turn and displayed `"terminated"`.
   - Any stream interrupted after emitting visible text (`passText.trim().length > 0`) now returns `finishReason: "INTERRUPTED"`, refreshes the `GoogleGenAI` client pool, and seamlessly hands off to the **Tail-Append Auto-Continuation Engine** (`<<<TAIL_START>>>...<<<TAIL_END>>>`) for up to 8 continuation passes.
   - Added `terminated`, `UND_ERR_`, `other side closed`, `502/503/504`, `UNAVAILABLE`, and `DEADLINE_EXCEEDED` to `TRANSIENT_STREAM_ERROR_RE` so pre-text thinking-phase drops automatically retry up to 3 times with exponential backoff.
   - Wrapped continuation passes in an inner `try/catch` so a late continuation network error gracefully preserves and commits all already-generated content and file proposals instead of crashing the turn.
   - Added a 15-second `{ t: "hb" }` keep-alive heartbeat over the NDJSON response stream.
2. **Updated `problems_faced/02_Vertex_Auth_OpenSSL_PEM_And_DNS_Resilience_Case_Study.md` & `problems_faced/README.md`**:
   - Added Challenge 3 documenting the `POST /api/chat 200 in 90623ms` `TypeError: terminated` root cause and auto-continuation recovery architecture.