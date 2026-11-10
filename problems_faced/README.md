# 🛠️ Engineering Challenges & Solutions (`problems_faced/`)

This folder documents the real-world systems engineering, memory management, security, and LLM streaming challenges encountered while building and stress-testing **Zero-Trust AI Studio**, along with the exact architectural solutions implemented.

## 📚 Case Studies Index

1. **[01 — Storage, RAM Dehydration, Proposal Expiration & Token Optimization Case Study](./01_Storage_RAM_And_Token_Optimization_Case_Study.md)**
   - **Challenge 1**: Prompt Token Explosion (`94,459` input tokens by Turn 14) & Vertex AI Context Cache Invalidation (`cached: 0`).
   - **Challenge 2**: Node.js RAM Bloat from holding snapshots, proposals, and undo stacks in memory.
   - **Challenge 3**: `"Proposal expired or not found"` when approving files after 15–60 minutes or across Next.js route workers.
   - **Challenge 4**: Mid-file truncation (`202 bytes` / `518 bytes` stubs) caused by `Thinking Process: ... close \`</file_zt...>\`` during multi-pass auto-continuation.