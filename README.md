# Deep Search

A local deep-research engine that goes further than commercial deep research:
more rounds, more hops, more sources, and more of the web — peer-reviewed papers
**and** the forums, threads, videos, and expert writing where practitioners
actually talk. Runs last minutes or hours. Everything runs on your machine;
AI is optional.

```
python deep_search.py --ui        # http://127.0.0.1:8765
```

## How a run works

```
Plan ──► Search ──► Read ──► Reflect ──► (repeat rounds) ──► Cross-check ──► Report
```

1. **Plan.** The topic is decomposed into research questions from complementary
   perspectives (evidence, practitioners, risks, experts, mechanisms, recent
   developments, …). With *Review the plan first* on, you edit the questions and
   searches before anything runs. With AI planning on, the model drafts the plan.
2. **Search.** Every query fans out across **source lanes** at once:
   academic (OpenAlex with abstracts, Semantic Scholar, Europe PMC, arXiv,
   Crossref, PubMed Central, DOAJ, open PDFs), community (Reddit + PullPush
   archive, Hacker News, Stack Exchange, forum operators), video (YouTube search),
   experts (Substack, Medium, podcasts), institutional (.gov, .edu), reference,
   news, code, Internet Archive, and the open web (SearXNG/DuckDuckGo/Bing/Mojeek,
   Brave).
3. **Read.** Candidates are prioritised by relevance × source quality × how far
   each lane is from your **research/community mix** target, and each reading
   batch is diversified across lanes. Specialised readers handle Reddit threads
   (post + top comments), Hacker News discussions, YouTube (description +
   transcript), and PDFs. Paywalled papers fall back to their index abstract;
   dead or blocked pages fall back to the Wayback Machine. Long documents keep
   only their most relevant passages.
4. **Hop.** Content links (scored by anchor text) and citation chains
   (references + cited-by) extend the frontier deeper. A semantic drift gate
   drops hops that wander off-topic without spending the source budget.
5. **Reflect.** Between rounds the engine distils learnings, measures how well
   each research question is covered, and issues follow-up searches for thin
   questions and **leads** — recurring names, entities, and terms the original
   queries never mentioned (snowballing). With AI planning on, the model also
   proposes gaps.
6. **Report.** Sources are ranked (BM25 + local embeddings + quality), grouped
   into independent families, and claims are cross-checked. The report has an
   executive summary, findings per research question, an explicit **Research vs.
   Community** comparison, corroborated vs. contested claims, notable voices,
   top videos, next digs, and a methodology log. With *AI-written report* on,
   each section is drafted from its own evidence and then synthesised, with
   every `[n]` citation validated.

Any result can be **dug deeper**: a follow-up run on a lead or narrower question
skips every source the parent already read.

## Depth presets

| Preset | Budget | Sources | Rounds | Angles | Hops |
|---|---|---|---|---|---|
| Scout | ~3 min | 30 | 1 | 4 | 1 |
| Standard | ~12 min | 90 | 3 | 6 | 2 |
| Deep | ~45 min | 300 | 8 | 8 | 3 |
| Marathon | 2–4 h | 1,500 | 30 | 12 | 4 |

Presets only fill defaults — every knob stays adjustable (up to 720 minutes,
5,000 sources). Use Scout to map the terrain, then dig deeper on what matters.

## Privacy layer (optional)

Off by default. When a topic touches something confidential:

- **Private words** never leave the machine in any mode (outbound guard on
  every collector task and model prompt; inbound redaction).
- **Placeholders** replace private words in searches (weaker results).
- **Decoy searches** make your real queries harder to single out.
- **Hide the process from the AI** buries the topic among decoy topics in
  planning prompts.

Network retrieval always runs in isolated collector processes; the core
process only talks to loopback (and OpenAI when AI options are on).

## Quick start

```bash
pip install -r requirements-core.txt -r requirements-collector.txt
python deep_search.py --ui                                   # browser UI
python deep_search.py --topic topic.txt --preset standard    # CLI
python deep_search.py --topic topic.txt --preset marathon --academic-weight 0.3
python deep_search.py --preview --preset deep                # show the plan budget
python deep_search.py --resume <run-id>                      # resume an interrupted run
```

Optional keys (Settings in the UI, or `.env`): `OPENAI_API_KEY` (AI planning and
reports), `BRAVE_SEARCH_API_KEY` (extra web index), `SEMANTIC_SCHOLAR_API_KEY`
(higher paper rate limits).

## Layout

```
frontend/            UI: index.html, css (tokens/layout/components), js
backend/privacy      air-gap, watchlist redaction, blinding, chaff, scratchpad
backend/retrieval    connectors, lanes + quality, vertical search, fetch readers, collector IPC
backend/frontier     priority frontier, hub-aware domain budgets, lane-diverse batches
backend/ranking      BM25 + FastEmbed + RRF, reranker
backend/research     options, presets, plan, explorer (rounds), reflection, telemetry, pipeline
backend/synthesis    deep report (local + sectioned AI), claim verification, report archive
backend/server       HTTP UI + API, run registry (re-attachable SSE streams)
deep_search.py       CLI and UI entrypoint
collector.py         isolated network worker
```

## Tests

```bash
python -m unittest test_safe_research.py test_bounded_contexts.py test_ai_search_expansion.py \
  test_deep_expansion.py test_durable_research_ledger.py test_evidence_independence.py \
  test_ultra_deep.py test_server_stream.py test_deep_research.py
```

All tests are network-free. `test_server_stream.py` drives the real UI in
headless Chromium when Playwright is installed.
