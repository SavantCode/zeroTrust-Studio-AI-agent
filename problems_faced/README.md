# 🛠️ Engineering Challenges & Solutions (`problems_faced/`)

This folder documents the real-world systems engineering, memory management, security, and LLM streaming challenges encountered while building and stress-testing **Zero-Trust AI Studio**, along with the exact architectural solutions implemented.

## 📚 Case Studies Index

1. **[01 — Storage, RAM Dehydration, Proposal Expiration & Token Optimization Case Study](./01_Storage_RAM_And_Token_Optimization_Case_Study.md)**
   - **Challenge 1**: Prompt Token Explosion (`94,459` input tokens by Turn 14) & Vertex AI Context Cache Invalidation (`cached: 0`).
   - **Challenge 2**: Node.js RAM Bloat from holding snapshots, proposals, and undo stacks in memory.
   - **Challenge 3**: `"Proposal expired or not found"` when approving files after 15–60 minutes or across Next.js route workers.
   - **Challenge 4**: Mid-file truncation (`202 bytes` / `518 bytes` stubs) caused by `Thinking Process: ... close \`</file_zt...>\`` during multi-pass auto-continuation.

2. **[02 — Vertex AI Authentication, OpenSSL 3 PEM Decoding, DNS Resilience & Undici `"terminated"` Stream Recovery](./02_Vertex_Auth_OpenSSL_PEM_And_DNS_Resilience_Case_Study.md)**
   - **Challenge 1**: `error:1E08010C:DECODER routines::unsupported` caused by OpenSSL 3 strict PEM framing when loading `GOOGLE_PRIVATE_KEY` from `.env`.
   - **Challenge 2**: `request to https://oauth2.googleapis.com/token failed, reason: getaddrinfo ENOTFOUND oauth2.googleapis.com` caused by Windows/Node.js dual-stack IPv6 DNS ordering, transient router DNS drops, or malformed `GOOGLE_TOKEN_URI` values.
   - **Challenge 3**: `TypeError: terminated` after ~90 seconds of streaming (`POST /api/chat 200 in 90623ms`) caused by Node Undici / Vertex SSE socket timeouts during long generations or thinking phases.