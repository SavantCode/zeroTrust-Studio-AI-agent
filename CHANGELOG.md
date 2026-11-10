## v3.2.0 — Comprehensive `README.md`, `.env.example` Template & `problems_faced/` Engineering Case Study

### What Changed
1. **Created `.env.example`**:
   - Added a complete, documented template of all required and optional environment variables (`GOOGLE_TYPE`, `GOOGLE_PROJECT_ID`, `GOOGLE_PRIVATE_KEY_ID`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_CLIENT_EMAIL`, `GOOGLE_CLIENT_ID`, `GOOGLE_AUTH_URI`, `GOOGLE_TOKEN_URI`, `GOOGLE_AUTH_PROVIDER_X509_CERT_URL`, `GOOGLE_CLIENT_X509_CERT_URL`, `GOOGLE_UNIVERSE_DOMAIN`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_APPLICATION_CREDENTIALS`, `GCP_PROJECT`, `GCP_LOCATION`, `MODEL`, `PORT`, `CONTEXT_CHAR_BUDGET`, `MAX_OUTPUT_TOKENS`).
2. **Updated `README.md`**:
   - Documented the full Zero-Trust AI Studio architecture (with Mermaid system diagram), step-by-step installation and startup guide, environment variable reference table, complete feature breakdown, under-the-hood lifecycle, and verification suite summary.
3. **Created `problems_faced/` Engineering Case Study (`problems_faced/README.md` & `problems_faced/01_Storage_RAM_And_Token_Optimization_Case_Study.md`)**:
   - Detailed the 4 real-world production challenges encountered during 14+ turn sessions (94k+ prompt token explosion & cache misses, Node.js RAM bloat, `"Proposal expired or not found"` across workers, and `Thinking Process: ... close \`</file_zt...>\`` mid-file truncation) and how the **3-Tier Smart Memory Architecture** resolved each one.