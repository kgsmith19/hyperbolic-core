# Deep Search

Air-gapped, privacy-preserving deep research. One search, explicit options, progressive depth.

Academic registries, SEC EDGAR, in-process SearXNG (DuckDuckGo + Bing), Playwright stealth crawling, local FastEmbed (`bge-small-en-v1.5`), and offline extractive synthesis.

## Bounded contexts

```
frontend/          HTML, CSS tokens, JS
backend/privacy    air-gap, watchlist, blinder, chaff, scratchpad
backend/retrieval  connectors, SSRF, collector IPC, retrieval/meta
backend/frontier   priority queue, territory reservation
backend/ranking    BM25 + dense + RRF
backend/synthesis  local extractive + optional cloud brief + reports
backend/research   SearchOptions, preview, planner, explorer, run_search
backend/server     threaded UI + /api
deep_search.py     CLI and UI entrypoint
collector.py       isolated network worker
```

## Invariants

1. Watchlist terms never leave Secret Core.
2. Dual discovery runs concurrently (OpenAlex, arXiv, Crossref, SEC EDGAR, SearXNG).
3. SearXNG at `127.0.0.1:8080` falls back to in-process DDG+Bing.
4. Tests: `python -m unittest test_safe_research.py test_bounded_contexts.py`

## Options

There is no mode enum. Defaults are fully local.

| Setting | You gain | You lose |
|---|---|---|
| `max_depth` | bounded hops | sources past hop N are never discovered |
| `max_documents` | bounded corpus | deeper sources discarded |
| `max_duration_sec` | hard stop | unfinished hops dropped |
| `concurrency` | faster hops | bot-blocks can stall depth |
| `blind_watchlist` | terms never leave | weaker recall |
| `decoy_queries` | k-anonymity | decoy searches yield no evidence |
| `ai_planning` | extra angles | topic leaves the machine |
| `ai_summary` | sourced brief | excerpts leave the machine |
| `max_spend_usd` | spend ceiling | downgrade to local synthesis if hit |

Blinding or decoys require confirm (`--yes` on CLI, checkbox in UI).

## Quick start

```bash
python deep_search.py --ui
python deep_search.py --topic topic.txt --watchlist watchlist.txt
python deep_search.py --preview --blind-watchlist --decoys 3
python deep_search.py --ai-planning --ai-summary --openai-model gpt-4o-mini --max-spend 2.00
```

Or double-click `Start-DeepSearch.bat`. UI: `http://127.0.0.1:8765`. SearXNG: `http://127.0.0.1:8080`.

## Tests

```bash
python -m unittest test_safe_research.py test_bounded_contexts.py
```
