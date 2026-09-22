# Deep Search - Session Checkpoint

**Status**: Lean Agentic DDD — one search, explicit options, renamed contexts.
**Tests**: `python -m unittest test_safe_research.py test_bounded_contexts.py`

## Public API

`run_search(topic, watchlist, options: SearchOptions) -> ResearchRun`

Preview: `preview(topic, options) -> SearchPreview` (`requires_confirm` iff `blind_watchlist` or `decoy_queries > 0`).

CLI: `python deep_search.py` — flags `--blind-watchlist --decoys --ai-planning --ai-summary --preview --yes --ui`. No `--mode`.

## Packages

privacy, retrieval (+ retrieval/meta), frontier, ranking, synthesis, research, server.

## Tradeoffs

Every option declares gain and depth cost in `backend/research/preview.py`. Decoy hits never rank. Cancel works because the UI server is threaded.

## Spec / plan

- `docs/superpowers/specs/2026-09-22-agentic-ddd-lean-search-design.md`
- `docs/superpowers/plans/2026-09-22-agentic-ddd-lean-search.md`
