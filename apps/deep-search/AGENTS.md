# Project Agent Instructions: deep-search

## Repository Overview
Deep Search is a local deep-research engine in Python 3.11/3.12. Its job is to
out-research commercial deep research by going deeper (more rounds, hops,
sources, and hours) and wider (academic + community + video + expert lanes).
One public use case: `run_search(topic, watchlist, options) -> ResearchRun`.
Options are independent; presets only fill defaults; there is no mode enum.
Privacy is an **optional layer**, not the main service.

## Key Invariants
1. **Watchlist never leaves**: watchlist terms, reverse alias maps, and
   secret-bearing text never reach collectors, search engines, or models
   (`assert_safe_to_send` on every task and prompt). Holds in every mode.
2. **Isolated retrieval**: all network retrieval runs in collector
   subprocesses over JSON IPC; the core process is socket-air-gapped to
   loopback (+ OpenAI when AI options are on). New network calls go through
   a collector action (`search`, `fetch`, `citations`), never the core.
3. **Concurrent discovery**: classic search fans out to OpenAlex, arXiv,
   Crossref, PubMed, Wikipedia, HN, SEC EDGAR, SearXNG, and Brave concurrently;
   lane search (`lanes` on the task) fans out per lane concurrently.
4. **SearXNG resilience**: `127.0.0.1:8080` with fallback to in-process
   DDG + Bing + Mojeek (per-engine throttling and cooldowns).
5. **Decoy hits never enter evidence.**
6. **Product defaults**: AI-written report ON when `OPENAI_API_KEY` is set (UI, API, CLI); every privacy/hiding option (`blind_watchlist`, `decoy_queries`, `llm_process=hide`, watchlist) is opt-in and never default.
7. **Library defaults stay conservative** (`SearchOptions()` = classic,
   breadth 1, no lanes); the UI/CLI presets turn depth up.
8. **Tests must pass** (all network-free):
   `python -m unittest test_safe_research.py test_bounded_contexts.py test_ai_search_expansion.py test_deep_expansion.py test_durable_research_ledger.py test_evidence_independence.py test_ultra_deep.py test_server_stream.py test_deep_research.py`

## Architecture Map
- `frontend/`: `index.html`, `css/{theme,layout,components}.css`, `js/{markdown,api_client,state_manager,ui_renderer,app}.js`.
- `backend/privacy/`: socket air-gap, watchlist redaction, token blinding, chaff, encrypted scratchpad, quarantine.
- `backend/retrieval/`: `retrieval_router.py` (classic + `search_lanes`, fetch readers, PDF, Wayback), `source_quality.py` (lanes, quality priors, mix targets), `connectors/` (scholarly, community/video/archive), `meta/` (DDG/Bing/Mojeek, `vertical_search.py`, `engine_health.py`).
- `backend/frontier/`: priority frontier with hub-aware domain keys, queue cap, `reprioritize`, lane-diverse `pop_next_batch`.
- `backend/ranking/`: BM25 + FastEmbed + RRF, reranker.
- `backend/research/`: `types.py`, `presets.py`, `research_plan.py`, `planner.py` (legacy query expansion), `explorer.py` (rounds), `reflection.py` (learnings, coverage, leads, passages), `telemetry.py`, `research_pipeline.py`.
- `backend/synthesis/`: `deep_report.py` (local + sectioned AI brief), `claim_verifier.py`, `report_generator.py`, legacy synthesizers.
- `backend/server/`: `web_server.py` (UI + API), `run_registry.py` (background runs, re-attachable SSE).
- Root: `deep_search.py` (CLI + UI), `collector.py` (IPC worker).

## Options (SearchOptions)
Depth: `max_depth`, `max_documents`, `max_duration_min`, `max_gap_rounds`, `breadth`, `queries_per_round`, `concurrency`, `max_per_domain`.
Sources: `academic_weight` (0..1), `source_lanes`, `results_per_lane`, `follow_leads`, `citation_expansion`, `exclude_urls`, `context_topic`, `plan`.
Quality: `chunk_documents`, `rerank_results`, `rerank_keep`, `claim_verification`, `graph_prioritization`, `query_rewrite`, `hyde_queries`.
AI: `ai_planning`, `ai_summary`, `llm_gap_rounds`, `concealer_model`, `deep_model`, `reasoning_effort`, `max_spend_usd`.
Privacy layer: `blind_watchlist`, `decoy_queries` (both require confirm), `llm_process` (`show` default, `hide` = chaffed prompts).

## Handoff
See `SESSION_CHECKPOINT.md` and `docs/superpowers/specs/2026-10-02-deep-research-engine-design.md`.
