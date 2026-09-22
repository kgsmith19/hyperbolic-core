# Project Agent Instructions: deep-search

## Repository Overview
Deep Search is a local, privacy-preserving, zero-secret-egress deep research engine built in Python 3.11/3.12. It combines local academic registries, SEC EDGAR, a built-in SearXNG meta-search engine (DuckDuckGo + Bing via `curl_cffi` TLS 124 impersonation), Playwright headless stealth crawling, local ONNX vector embeddings (`bge-small-en-v1.5`), and air-gapped CPU synthesis.

The project is structured according to **Domain Bounded Contexts** split between `frontend/` (modular HTML, CSS design tokens, JS state and rendering) and `backend/` (domain-driven bounded contexts).

## Key Invariants
1. **Zero-Secret-Egress**: The Secret Core controller (`backend.security_guard` / `safe_research.py`) must never expose watchlist terms, raw queries, reverse alias maps, or secret-bearing documents to network workers or external services.
2. **Dual Discovery**: Searches query OpenAlex, arXiv, Crossref, SEC EDGAR, and SearXNG simultaneously—never one or the other.
3. **Resilience**: The SearXNG connector queries `http://127.0.0.1:8080` with seamless fallback to in-process meta-search so retrieval never fails.
4. **All Tests Must Pass**: Run `python -m unittest test_safe_research.py test_bounded_contexts.py` before finalizing any changes.

## Architecture Map
- `frontend/`:
  - `public/index.html`: Semantic HTML5 layout.
  - `css/`: `theme.css` (tokens/resets), `layout.css` (containers/grid), `components.css` (cards/badges/inputs).
  - `js/`: `api_client.js` (REST), `state_manager.js` (reactive store), `ui_renderer.js` (DOM rendering), `app.js` (lifecycle).
- `backend/`:
  - `security_guard/`: Physical socket air-gap, watchlist matching/redaction, token blinding, k-anonymity chaffing, AES-256-GCM encrypted scratchpad, memory zeroization (`ctypes.memset`), quarantine zone.
  - `retrieval_engine/`: Network worker IPC, SSRF protection, bot barrier detection, content extraction, and decoupled connectors (`openalex`, `arxiv`, `crossref`, `sec_edgar`, `brave`, `searxng`, `browser_crawler`).
  - `meta_search/`: Built-in local SearXNG-compatible server (`127.0.0.1:8080`), DuckDuckGo & Bing scrapers with TLS 124 impersonation.
  - `discovery_frontier/`: Bounded priority queue, multi-hop cycle detection, SHA-256 content deduplication, domain budget enforcement.
  - `relevance_ranking/`: Local Okapi BM25 + ONNX FastEmbed dense vector embeddings (`bge-small-en-v1.5`) + Reciprocal Rank Fusion (RRF).
  - `synthesis_intelligence/`: Offline CPU extractive summarization, gap analysis, cloud LLM synthesis fallback, and Markdown report generator.
  - `research_orchestrator/`: End-to-end pipeline execution (`run_research`), multi-angle query planning, and evidence aggregation.
  - `server/`: HTTP web server serving `frontend/` static assets and `/api/*` endpoints, plus `.env` configuration management.
- Root entrypoints (`safe_research.py`, `collector.py`): Primary entrypoints delegating cleanly to `backend/`. Helper shims have been retired in favor of direct bounded context imports.

## Handoff & Continuity
For resuming sessions or tracking progress, consult `SESSION_CHECKPOINT.md`.
