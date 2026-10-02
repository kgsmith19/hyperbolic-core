# Deep Search - Session Checkpoint

**Status**: Deep-research engine overhaul complete (2026-10-02). Privacy is an
optional layer; the product is the deep search.

**Tests**: 205 network-free tests —
`python -m unittest test_safe_research.py test_bounded_contexts.py test_ai_search_expansion.py test_deep_expansion.py test_durable_research_ledger.py test_evidence_independence.py test_ultra_deep.py test_server_stream.py test_deep_research.py`

## What changed

- **Plan → rounds → report loop**: `research_plan.py` (perspective plan, model
  plan in show mode, user-edited plan), `explorer.py` (round-based reflection,
  lane-balanced priorities, lane-diverse batches, abstract + Wayback fallbacks,
  best-passage excerpts, semantic drift gate, citation edges via collector),
  `reflection.py` (learnings, coverage, lead snowballing).
- **Source lanes**: `source_quality.py` + `retrieval_router.search_lanes`; new
  connectors (Semantic Scholar, Europe PMC, DOAJ, Reddit/PullPush, Stack
  Exchange, GitHub, Internet Archive, YouTube search); readers for Reddit
  threads, HN items, YouTube transcripts, PDFs.
- **Report**: `deep_report.py` local structured brief + sectioned AI brief with
  citation validation; JSON archive next to each markdown report.
- **Server**: run registry (background runs, re-attachable SSE), `/api/plan`,
  `/api/presets`, `/api/runs`, `/api/runs/stream`, `/api/reports/result`,
  cancel by run id.
- **UI**: full redesign — presets, research/community slider, lane chips, plan
  review, live run view (stepper, meters, counters, Sounding depth chart, lane
  mix, live sources/learnings/activity/questions), results reader (TOC, citation
  popovers, sources filter, research log, next digs, method).
- **Defaults**: `llm_process` now defaults to `show` (owner direction: privacy optional).

## Known limits / next ideas

- Reddit's own JSON is blocked from many networks; PullPush archive covers search + comments.
- Bing's HTML endpoint ignores `site:`; vertical results are post-filtered by domain.
- Mojeek often serves a captcha; engine cooldowns route around it.
- Next: multi-provider LLMs (Anthropic/Gemini via an OpenAI-compatible base URL) need an air-gap allowlist change.
