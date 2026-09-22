# Project Agent Instructions: deep-search

## Repository Overview
Deep Search is a local, privacy-preserving, zero-secret-egress deep research engine built in Python 3.11/3.12. One public use case: `run_search(topic, watchlist, options) -> ResearchRun`. Options are independent; there is no mode enum.

## Key Invariants
1. **Zero-Secret-Egress**: `backend.privacy` must never expose watchlist terms, reverse alias maps, or secret-bearing documents to network workers or external services.
2. **Dual Discovery**: Searches query OpenAlex, arXiv, Crossref, SEC EDGAR, and SearXNG concurrently — never sequentially, never one or the other.
3. **Resilience**: The SearXNG connector queries `http://127.0.0.1:8080` with fallback to in-process meta-search.
4. **All Tests Must Pass**: Run `python -m unittest test_safe_research.py test_bounded_contexts.py` before finalizing any changes.

## Architecture Map
- `frontend/`: HTML, CSS tokens, JS (`api_client.js`, `state_manager.js`, `ui_renderer.js`, `app.js`).
- `backend/`:
  - `privacy/`: Socket air-gap, watchlist redaction, token blinding, k-anonymity chaffing, encrypted scratchpad, quarantine.
  - `retrieval/`: Network worker IPC, SSRF, connectors, `retrieval/meta/` (DDG + Bing + local SearXNG server).
  - `frontier/`: Bounded priority queue, cycle detection, territory reservation.
  - `ranking/`: BM25 + ONNX FastEmbed + RRF.
  - `synthesis/`: Local extractive summarizer, optional cloud brief, Markdown reports.
  - `research/`: `SearchOptions`, `preview()`, planner, explorer, `run_search`.
  - `server/`: Threaded HTTP UI and `/api/*`.
- Root: `deep_search.py` (CLI + UI), `collector.py` (IPC worker).

## Options
Independent knobs on `SearchOptions`: `max_depth`, `max_documents`, `concurrency`, `max_duration_sec`, `blind_watchlist`, `decoy_queries`, `ai_planning`, `ai_summary`, `model`, `reasoning_effort`, `max_spend_usd`. Quality-reducing combos (`blind_watchlist` or `decoy_queries > 0`) require confirm. Decoy hits never enter ranked evidence.

## Handoff
See `SESSION_CHECKPOINT.md` and `docs/superpowers/specs/2026-09-22-agentic-ddd-lean-search-design.md`.
