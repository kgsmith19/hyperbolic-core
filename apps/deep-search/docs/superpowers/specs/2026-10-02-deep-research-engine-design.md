# Deep Research Engine — Design (2026-10-02)

## Intent (owner)

Make the deep search itself the product: better than commercial deep research
because it is allowed to go further — more sources, deeper into each source,
more of the (legal) deep web, for as long as the user wants (hours). Balance
top academic and peer-reviewed work with community consensus (forums, Reddit,
discussion boards, experts, videos), 50/50 by default and user-adjustable.
Support short scouting runs that lead into deep digs. Privacy/concealment stays
available as an optional layer, not the main service.

## What the frontier products do (researched 2026-10)

| System | Technique we adopted |
|---|---|
| OpenAI deep research | Agentic multi-step browsing that pivots on what it reads; documented citations; real-time progress and interruption |
| Gemini Deep Research | Editable multi-point **research plan** shown before running; iterative search → reason → next move; long reports |
| Anthropic Research | Orchestrator/worker: decompose, run **parallel sub-investigations**, start wide then narrow, prefer high-quality primary sources over SEO pages, dedicated citation pass |
| Perplexity Deep Research | Dozens of searches, hundreds of sources, refine the plan as understanding grows |
| Google TTD-DR | Draft → retrieve → revise ("denoising with retrieval") |
| STORM / dzhng deep-research | Perspective-guided questions; breadth × depth recursion carrying **learnings** and follow-up directions |

Commercial limits we exceed: wall-clock (~5–30 min), source counts (tens to a
few hundred), one source mix, no user control over depth, no resumable runs.

## Architecture

```
plan (local perspectives | model JSON | user-edited)
  └─ queries per sub-question, preferred lanes
explore (rounds)
  ├─ search: task.lanes = budget per lane (mix targets × deficit × preferred lanes)
  ├─ read: priority = relevance + 12·quality + lane bonus; batches capped at 50% per lane
  │        readers: reddit/HN/youtube/pdf; fallbacks: abstract, Wayback
  ├─ hop: anchor-scored links, citation edges (collector `citations` action)
  │        drift gate: FastEmbed cosine ≥ 0.70 for hops/citations
  └─ reflect every ⌈docs/(rounds+1)⌉ docs or when the queue drains:
       learnings → coverage per sub-question → follow-ups (model gaps for the
       first `llm_gap_rounds`, thin-question queries, lead snowballing, concept
       graph gaps) → citation expansion → queue re-score
rank (BM25 + dense RRF, quality blend, rerank) → families → claim check
report (local structured | sectioned AI with citation validation) + JSON archive
```

### Lanes and the mix

`source_quality.classify_lane` assigns academic, gov, reference, filings
(evidence group), community, video, expert (discussion group), or news, code,
archive, web (neutral). `mix_targets(w)` gives the evidence group `w·80%`, the
discussion group `(1−w)·80%`, neutral 20%. The explorer keeps the corpus near
target three ways: per-query lane budgets, a lane bonus on queue priority
(re-scored after every batch), and lane-diverse batch selection.

### Quality

`quality_prior` = lane base + citation/score/view signals − preprint/low-quality
domain/listicle penalties. It feeds queue priority, final ranking, citation-seed
selection, and the report's sentence scoring. Report sentences are scored for
"finding-ness" (results verbs, numbers, structured-abstract labels) and filtered
for methods boilerplate and page chrome; documents below a relative topic
similarity floor are excluded from summary sections.

### Live telemetry

`Telemetry` emits `stage`, `stats`, `plan`, `round`, `source`, `learning` events
(plus plain progress lines). The server's `RunRegistry` runs each search on a
background thread and buffers events so the UI can reload and re-attach to a
multi-hour run.

## Defaults and compatibility

- `SearchOptions()` keeps classic behavior (breadth 1, no lanes) so library
  callers and tests are stable; presets (`presets.py`) drive the product.
- `llm_process` default changed `hide` → `show` per owner direction; tests updated.
- Task schema gained `lanes`, `limit`, and the `citations` action; validator enforces types and bounds.

## Verification

- 205 network-free unit/integration tests, including a headless-Chromium UI run.
- Live Scout run (creatine/cognition): 30 sources, 4 questions, mix converged to
  ~52% research / 39% community against a 50/50 target; summary led with the
  meta-analytic effect size; AI sectioned report verified with gpt-4o-mini ($0.002).
