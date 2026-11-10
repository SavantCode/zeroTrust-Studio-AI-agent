## v3.0.6 — Non-Greedy Nested Tag Guard & Multi-Pass Cutoff Simulation Test

### What Changed
1. **Orphan Open-Tag Sanitizer & Non-Greedy `FILE_RE` (`src/lib/proposals.ts`)**:
   - Hardened `FILE_RE` with a negative lookahead `((?:(?!<file_... path=)[\s\S])*?)` and added `removeOrphanOpenFileTags()` so if a model ever outputs a partial `<file_...>` tag followed by a fresh `<file_...>` tag, the partial orphan never swallows the completed file.
   - Enhanced `stitchContinuation()` to automatically unwrap outer markdown code fences (` ```xml ... ``` `) if a model wraps its continuation chunk in backticks, and lowered the seam overlap threshold to `6` characters for tighter boundary deduplication.
2. **End-to-End Multi-Pass Cutoff Simulation (`scripts/verify-studio.mjs`)**:
   - Upgraded Test 7 to simulate a live 3-pass cutoff scenario (`_4_Gas_Station.md` cut off mid-Java block -> stitched in Pass 1 -> `_5_Candy.md` cut off -> stitched in Pass 2 with `_1_Task_Scheduler.md` and `CHANGELOG.md`) and verified that all 4 files extract cleanly with zero cutoff warnings.

---

## v3.0.5 — Fix Next.js 15 Route Type Check (`TS2344`) & Cross-Restart Tag Unification

### Why `npx tsc --noEmit` Failed
- Next.js 15 App Router generates `.next/types/app/api/chat/route.ts` which enforces that `app/api/**/route.ts` modules **only** export valid HTTP handler methods (`GET`, `POST`, etc.) and route segment config properties (`maxDuration`).
- Exporting helper functions (`export function findUnclosedFileTag` and `export function stitchContinuation`) directly from `src/app/api/chat/route.ts` violated Next.js's `{ [x: string]: never }` constraint on `OmitWithTag`.

### What Changed
1. **Moved `findUnclosedFileTag` & `stitchContinuation` to `src/lib/proposals.ts`**:
   - Exported both helpers from `src/lib/proposals.ts` and imported them into `src/app/api/chat/route.ts`, leaving only `export const maxDuration = 300` and `export async function POST` in `route.ts`.
2. **Cross-Restart Tag Matching & History Tag Unification (`src/lib/proposals.ts`, `src/app/api/chat/route.ts`)**:
   - Updated `FILE_RE`, `DEL_RE`, `CMD_RE`, `NEXT_RE`, and `TRUNC_FILE_RE` to recognize any `zt<hex>` tag suffix so even if the server restarts between turns, historical or mixed tag suffixes are always parsed cleanly.
   - Added `unifyHistoryTagKeys()` in `normalizeTurnPairs()` so prior turns loaded from `history.jsonl` always present the current process's `TAG_KEY` to the model.

---

## v3.0.4 — Seamless Tail-Append Stream Continuation & Stepped Token Budget Cascade

### Why Previous Multi-File Responses Were Cut Off Mid-File
- **Root Cause #1 (Discarding Partial Files on Continuation)**: When a stream hit an output token limit mid-file (e.g., inside `greedy_new/05_Greedy_Array_Prefix/_4_Gas_Station.md`), the previous continuation loop executed `full = full.slice(0, truncCheck.openTagIndex)`—deleting the entire partial file—and asked the model to rewrite the file from line 1 plus all remaining files. This caused Pass 1 and Pass 2 to hit the token limit at the exact same place inside the same file.
- **Root Cause #2 (All-or-Nothing `maxOutputTokens` Fallback)**: If a model rejected `maxOutputTokens: 65536`, the fallback omitted `maxOutputTokens` entirely instead of stepping down to `32768` / `16384` / `8192`.

### What Changed
1. **Seamless Tail-Append Continuation (`stitchContinuation` in `src/app/api/chat/route.ts`)**:
   - Preserves all already-generated partial file content in `full`, sends the exact tail (`<<<TAIL_START>>>...<<<TAIL_END>>>`), and instructs the model to continue from the exact character where it left off and close with `</file_...>`.
   - Automatically deduplicates any repeated boundary lines at the seam and also handles the fallback case if a model re-opens the `<file_...>` tag.
   - Increased continuation capacity to **5 passes** (`MAX_CONTINUATION_PASSES = 5`) with mid-stream interruption recovery.
2. **Stepped `maxOutputTokens` Cascade (`[65536, 32768, 16384, 8192, undefined]`)**:
   - Ensures every Vertex AI model always uses its highest supported output token budget per pass.
3. **Verification Suite (`scripts/verify-studio.mjs`)**:
   - Added Test 7 verifying `stitchContinuation`, the 5-pass continuation loop, and the stepped token budget cascade.

---

## v3.0.3 — Cryptographic JWT Self-Test & Anti-Cutoff Automatic Stream Continuation

### What Changed
1. **RSA-SHA256 JWT Signature Verification (`src/lib/config.ts`)**:
   - Enhanced `validateAndCanonicalizePrivateKey()` to not only parse and export canonical PKCS#8 PEM via `crypto.createPrivateKey()`, but also execute a live `crypto.sign("RSA-SHA256", ...)` test signature—the exact cryptographic operation `google-auth-library` uses to sign Vertex AI OAuth2 tokens.
2. **65,536 Output Token Budget & Seamless Auto-Continuation (`src/app/api/chat/route.ts`)**:
   - Configured `maxOutputTokens: 65536` (with graceful fallback if a specific model enforces a lower cap) and `export const maxDuration = 300` so large multi-file generations have maximum headroom.
   - Added `findUnclosedFileTag()` and a 2-pass **Automatic Anti-Cutoff Continuation** loop inside `/api/chat`: if a response ever hits `MAX_TOKENS` or ends mid-`<file_...>` tag, the server automatically resumes generation in the same stream and re-emits the interrupted file completely so no file is ever truncated or lost.