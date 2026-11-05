# Lean Agentic DDD: One Search, Explicit Options

**Date:** 2026-09-22
**Status:** Approved design (awaiting implementation plan)
**Scope:** Restructure Deep Search around a single use case with explicit options, typed domain objects, lean bounded contexts, and declared tradeoffs. Hard cut — no compatibility aliases for modes, package names, or the `safe_research.py` facade.

## Problem

The codebase already has bounded-context *folders*. The internals do not.

- Four mode strings (`deterministic`, `extreme`, `expansion`, `full`) secretly bundle independent switches. Combinations that users need (blind + cloud summary, planning + decoys) are impossible.
- The advertised stealth path is dead: `run_research` never dispatches decoy queries.
- `safe_research.py` re-exports ~40 symbols; tests import the domain through that barrel.
- Evidence, tasks, and run results are raw dicts. There is no shared language for agents.
- `run_research` is a 370-line script, not an orchestrator.
- Contexts leak (retrieval imports privacy and frontier; connectors import meta-search).
- The UI server is single-threaded, so cancel cannot interrupt a run.
- Connector search is sequential, contradicting the dual-discovery invariant.
- Names are marketing (`synthesis_intelligence`, `LocalSLMEngine`) rather than ubiquitous language.

## Goals

1. One public use case: `run_search(topic, watchlist, options) -> ResearchRun`.
2. Options are independent, named by what they do. No mode enum.
3. The run is always progressive depth. Options only set budgets or accept tradeoffs.
4. Every option declares its gain and its depth cost. Quality-reducing options require explicit confirm.
5. Agents have typed in/out. The orchestrator is the only composer.
6. Package names match the language. Dead code and barrels die.
7. Security invariants stay: zero secret egress, SSRF, IPC schema, socket air-gap.
8. All tests pass after each slice. Tests import from contexts, never a god facade.

## Non-goals

- New connectors, rankers, or synthesis models.
- Frontend visual redesign beyond ripping mode cards and wiring toggles + preview.
- Docker or launcher polish except names that would otherwise lie.
- Compatibility aliases for old modes, packages, or `safe_research.py`.
- An agent framework, event bus, or ports-and-adapters ceremony.

---

## 1. Domain language

### SearchOptions

Independent knobs. Defaults produce a fully local, unblinded, no-decoy, no-LLM search.

```python
@dataclass
class SearchOptions:
    # Discovery budgets — the run always deepens until a budget runs out
    max_depth: int = 2
    max_documents: int = 15
    concurrency: int = 4
    max_duration_sec: float = 180.0
    max_per_domain: int = 4

    # Privacy — what may leave the machine
    blind_watchlist: bool = False   # pseudonymize watchlist terms; else assert-and-block
    decoy_queries: int = 0          # k-anonymity chaff count; 0 = off

    # AI — where, if anywhere, bytes go to an LLM
    ai_planning: bool = False       # expand topic into multiple query angles
    ai_summary: bool = False        # cloud-written executive brief
    model: str = "gpt-4o-mini"
    reasoning_effort: str | None = None
    max_spend_usd: float = 2.00
```

Old modes do not exist. They were secretly these combinations:

| Old mode | Equivalent options |
|---|---|
| `deterministic` | defaults |
| `extreme` | `blind_watchlist=True, decoy_queries=3` |
| `expansion` | `ai_planning=True` |
| `full` | `ai_planning=True, ai_summary=True` |

Those combinations remain available as UI/CLI macros that flip options. They are not domain concepts.

### Evidence, Query, SearchPreview, ResearchRun

```python
@dataclass(frozen=True)
class Evidence:
    title: str
    url: str
    snippet: str
    excerpt: str = ""
    doi: str = ""
    depth: int = 0
    source: str = ""
    score: float = 0.0

@dataclass(frozen=True)
class Query:
    text: str
    is_decoy: bool = False

@dataclass(frozen=True)
class SearchPreview:
    expected_hops: int
    expected_sources: int
    expected_duration_sec: float
    expected_spend_usd: float
    expected_cost_display: str
    warnings: list[str]          # from the tradeoff table, current combination only
    requires_confirm: bool       # True iff blind_watchlist or decoy_queries > 0

@dataclass
class ResearchRun:
    topic: str
    options: SearchOptions
    queries: list[Query]
    evidence: list[Evidence]
    summary: str
    spend: SpendReport
    duration_sec: float
    archive_path: str
    status: str                  # success | cancelled | blocked
```

Dicts may exist at adapter edges (HTTP JSON, collector IPC). They convert to these types at the boundary. Internal pipeline code never uses `item.get("excerpt") or item.get("content")`.

### SpendReport

Keep the existing `SpendReport` dataclass and `CostTracker` behavior. Move them into `backend/research/` with the use case they serve.

---

## 2. Progressive depth and declared tradeoffs

The run shape never changes:

1. Seed every connector with the planned queries (decoys included, tagged).
2. Fetch highest-priority candidates in concurrent batches with territory reservation.
3. Follow outbound links hop by hop.
4. After the first hop, gap analysis may seed extra angles.
5. Stop when a budget runs out, cancel fires, or the frontier empties.
6. Rank, synthesize, archive.

There is no shallow mode. Smaller budgets produce a shorter progressive run.

### Tradeoff table (canonical copy)

Every option's gain and depth cost live in one module (`backend/research/preview.py`). UI, CLI, and `/api/estimate` render this table. Do not duplicate the copy.

| Setting | You gain | You lose |
|---|---|---|
| `max_depth` | bounded hops | sources past hop N are never discovered |
| `max_documents` | bounded corpus | deep sources beyond N are discarded |
| `max_duration_sec` | hard stop | unfinished hops dropped mid-run |
| `concurrency` ↑ | faster hops | bot-blocks rise; a blocked worker stalls depth |
| `blind_watchlist` | watchlist terms never leave the machine | engines see placeholders → weaker recall |
| `decoy_queries: k` | real query hides among k decoys | k decoy searches run for real and yield no evidence |
| `ai_planning` | diverse angles find what keyword search misses | topic leaves the machine; small spend |
| `ai_summary` | readable sourced brief | excerpts leave the machine; spend scales with corpus |
| `max_spend_usd` | hard spend ceiling | run downgrades to local synthesis if the cap is hit |

### Preview rules

1. No silent limits. Caps are stated in outcome terms ("stops at hop 3, ~15 sources"), never in parameter names alone.
2. Privacy/AI settings state their depth price. Blinding and decoys are the two settings that can reduce result quality; the preview must say so before launch.
3. `requires_confirm` is true if and only if `blind_watchlist` is true or `decoy_queries > 0`.
4. Quality-reducing combos show the warning **and** require explicit confirm. CLI waits for `y` unless `--yes`. UI keeps the launch button disabled until a confirm checkbox is checked ("I accept weaker recall").

---

## 3. Agents

Each agent is a function (or a small class if it holds a client) with typed in/out. No agent imports another agent. Only `run_search` composes them.

| Agent | Module | In | Out |
|---|---|---|---|
| Preview | `backend/research/preview.py` | topic + `SearchOptions` | `SearchPreview` |
| Guard | `backend/privacy/` (existing modules, thinner public surface) | topic + watchlist + options | safe or blinded topic |
| Planner | `backend/research/planner.py` | topic + watchlist + options + cost tracker | `list[Query]` |
| Explorer | `backend/research/explorer.py` | queries + watchlist + options + cancel token | `list[Evidence]` |
| Ranker | `backend/ranking/` | topic + evidence | ranked `list[Evidence]` |
| Synthesizer | `backend/synthesis/` | topic + evidence + watchlist + options + cost tracker | summary `str` |
| Reporter | `backend/synthesis/report.py` | topic + evidence + summary + watchlist + metadata | archive path |

`run_search` in `backend/research/pipeline.py` is the only public use case besides `preview`.

### Planner rules

- Always include the (possibly blinded) topic as the first real query.
- If `ai_planning`, call the LLM for 3 additional angles. On missing key, spend cap, or API failure: fall back to `[topic]`.
- If `decoy_queries = k > 0`, generate k decoys and mix them into the list, tagged `is_decoy=True`.
- Never send watchlist terms. Assert or blind first, depending on options.

### Explorer rules

- Dispatch real and decoy queries to connectors. Tag results by originating query.
- Discard every result whose originating query `is_decoy=True`. Decoy hits never enter the frontier, never rank, never appear in the report.
- Search all connectors concurrently (OpenAlex, arXiv, Crossref, SEC EDGAR, SearXNG, Brave if keyed). Sequential fan-out is a bug.
- Check the cancel token between batches. On cancel, return evidence collected so far.
- Gap analysis runs once after the first successful hop if at least two real documents exist and budgets remain.

### Synthesizer rules

- If `ai_summary` and an API key is present and spend remains: cloud summary, then redact.
- Otherwise: local extractive synthesis, then redact.
- On spend cap or API failure: local extractive. Do not raise out of `run_search`.

### Guard rules

- If `ai_planning` or `ai_summary`: air-gap with `allow_openai=True`. Else air-gap closed.
- If `blind_watchlist`: build a blinder and return the blinded topic. Reverse map stays inside privacy; it never leaves Secret Core and is not sent to the collector.
- Else: `assert_safe_to_send(topic, watchlist)`. Raise `SafetyError` on hit.

`rehydrate_text` is unused in production today. Keep the function in `privacy` (tests cover round-trip) but do not wire it into the pipeline. Blinded placeholders stay blinded in reports.

---

## 4. Package map (hard cut)

| Now | Becomes | Notes |
|---|---|---|
| `backend/security_guard/` | `backend/privacy/` | Public surface: air-gap, `SafetyError`, redact/assert, blinder, chaffer, `SecureZeroBuffer`. Stop exporting privates (`_build_term_pattern`). |
| `backend/retrieval_engine/` + `backend/meta_search/` | `backend/retrieval/` | One ingest context. Academic/web fetchers stay in `retrieval/connectors/`. DDG, Bing, aggregator, and the local SearXNG server live in `retrieval/meta/`. |
| `backend/discovery_frontier/` | `backend/frontier/` | Same classes, shorter package. |
| `backend/relevance_ranking/` | `backend/ranking/` | Ranker accepts and returns `list[Evidence]`. |
| `backend/synthesis_intelligence/` | `backend/synthesis/` | Rename `LocalSLMEngine` → `LocalSynthesizer`. |
| `backend/research_orchestrator/` | `backend/research/` | Types, preview, planner, explorer, pipeline, cost, cancel. |
| `backend/server/` | `backend/server/` | Unchanged name. Threaded. Talks only to `research` + `privacy.SafetyError`. |
| `safe_research.py` | `deep_search.py` | CLI + `--ui`. Imports `run_search`, `preview`, `SearchOptions`. No barrel re-exports. |
| `collector.py` | `collector.py` | Keep. Point at `backend.retrieval`. |

Delete, do not alias:

- `rank_evidence`, `OPENAI_PRICING`, `cancel` (keep `cancel_run`), `release_in_flight` (keep `release_candidate`), `complete_candidate` if unused.
- `CollectorClient.search_brave`, `fetch_html_text`, `build_sanitized_evidence` (pipeline unused).
- `RetrievalRouter.search_*` pass-through methods; call connectors directly from `search()`.
- `__init__.py` exports of `_build_term_pattern` and `_compute_subword_fallback_scores`.

Wire inbound collector sanitization through `SanitizedQuarantine.process_payload` so there is one quarantine path. Delete the duplicate regex walk in `CollectorClient._sanitize_quarantined_payload`.

---

## 5. Flow

```
topic + watchlist + SearchOptions
        │
        ▼
   preview()  →  SearchPreview
        │          hops, sources, time, spend, warnings
        │          requires_confirm if blind or decoys
        ▼
   [CLI: print warnings, wait for y unless --yes]
   [UI: launch disabled until confirm checkbox]
        ▼
   run_search()
        ├─ Guard
        ├─ Planner     queries (+ decoys mixed, tagged)
        ├─ Explorer    parallel connectors, hops, gap seeds
        │              decoy hits discarded
        ├─ Ranker
        ├─ Synthesizer
        └─ Reporter    reports/<ts>_<slug>.md + report.md
        ▼
   ResearchRun
```

Cancel is checked between explorer batches. Partial evidence still ranks, synthesizes, and archives. `status = "cancelled"`.

### Errors (no silent `except Exception: pass` at the CLI or orchestrator)

| Failure | Behavior |
|---|---|
| Watchlist in outbound payload | `SafetyError` → `status="blocked"`, nothing sent |
| Spend cap hit | stop cloud calls, finish locally, report includes the cap |
| Connector / fetch error | skip that source, continue (connectors may catch network errors; they must log, not `pass` silently in the orchestrator) |
| OpenAI down | planner → `[topic]`; synthesizer → local extractive |
| Cancel | stop new work, compile what we have |

CLI prints errors. `deep_search.py` must not swallow `Exception`.

---

## 6. CLI

Entrypoint: `deep_search.py`.

```
python deep_search.py --topic topic.txt --watchlist watchlist.txt
python deep_search.py --ui
python deep_search.py --preview --topic topic.txt --blind-watchlist --decoys 3
```

Flags (no `--mode`):

- `--max-depth --max-docs --concurrency --max-duration --max-per-domain`
- `--blind-watchlist --decoys N`
- `--ai-planning --ai-summary`
- `--openai-model --reasoning-effort --max-spend`
- `--preview` print `SearchPreview` and exit
- `--yes` skip confirm
- `--ui` start the threaded web UI

If `requires_confirm` and not `--yes`, print warnings to stdout and wait for `y`.

Update `Start-DeepSearch.bat` to call `deep_search.py --ui`. Desktop launchers that point at `safe_research.py` must be updated or they will lie.

---

## 7. HTTP API and UI

### Server

- Use `socketserver.ThreadingMixIn` (or `ThreadingTCPServer`) so `POST /api/cancel` can run while `POST /api/research` is in flight. This is a correctness fix, not polish.
- `POST /api/research` accepts the option fields listed above. Reject unknown `mode` if present (hard cut — do not translate).
- `POST /api/estimate` returns a `SearchPreview` JSON object (hops, sources, duration, spend, warnings, `requires_confirm`).
- `/api/cancel`, `/api/models`, `/api/settings`, `/api/reports` stay.

### UI

- Remove the four mode cards.
- One search form: topic, watchlist, budget sliders, privacy toggles (`blind_watchlist`, `decoy_queries`), AI toggles (`ai_planning`, `ai_summary`), model, spend cap.
- Optional quick-set buttons are macros only. They set options; they are not a second source of truth. Labels describe the tradeoff, e.g. "Private & Local (weaker recall)".
- Preview card replaces the estimate card: hops, sources, time, spend, warnings.
- When `requires_confirm`, a checkbox "I accept weaker recall" must be checked before Launch enables.
- Cancel button remains. It must actually stop a running search.

---

## 8. Testing

Command stays:

```
python -m unittest test_safe_research.py test_bounded_contexts.py
```

Rename the files in a later slice if desired; not required for the hard cut. What is required:

- Tests import from `backend.privacy`, `backend.research`, `backend.retrieval`, `backend.frontier`, `backend.ranking`, `backend.synthesis`. Never from a facade.
- Keep every existing security invariant (redaction variants, SSRF, IPC schema, quarantine, air-gap, ranking determinism).
- Add:
  - Defaults, blind+decoys, planning, summary each take the right agent path (mock collector / OpenAI).
  - Decoy-originated results never appear in `ResearchRun.evidence`.
  - `SearchPreview.requires_confirm` is true iff `blind_watchlist` or `decoy_queries > 0`.
  - Cancel during a blocked fetch stops the run (`status="cancelled"`) and still writes a report.
  - CLI / API reject `--mode` / `"mode"` rather than translating it.

`test_safe_research.py` currently imports ~20 names from `safe_research`. Rewrite those imports to the owning context as the barrel dies.

---

## 9. Invariants that must not regress

1. **Zero secret egress.** Watchlist terms, reverse alias maps, and secret-bearing documents never go to the collector, OpenAI, or SearXNG.
2. **Dual discovery.** A search hits academic registries, SEC EDGAR, and SearXNG concurrently — never one or the other, never sequentially.
3. **SearXNG resilience.** Connector queries `http://127.0.0.1:8080` and falls back to in-process DDG+Bing.
4. **Tests pass** before any slice is considered done.

---

## 10. Implementation order (for the later plan)

Slices, each test-green:

1. **Types + preview.** Add `SearchOptions`, `Evidence`, `Query`, `SearchPreview`, `preview()` under the *current* package `backend/research_orchestrator/` (`types.py`, `preview.py`). Tests for the tradeoff table and `requires_confirm`. No package rename yet.
2. **Split `run_research` into agents** still living under current packages (`query_planner.py` → planner, new `explorer.py`, typed evidence through ranker/synthesis). Wire decoys for real. Parallel connector search.
3. **Hard rename.** Packages move to the map in §4. `deep_search.py` replaces `safe_research.py`. Kill the barrel. Update tests, docs, and `Start-DeepSearch.bat`. Thread the UI server. Replace mode cards with toggles + confirm.
4. **Delete dead code** listed in §4. Confirm tests still pass.

Do not mix slice 3 (rename) with slice 2 (behavior). Rename last so diffs stay reviewable. Default `max_duration_sec` is 180.0 (CLI/UI today; the pipeline's 120.0 default is a bug and dies).

---

## 11. Success criteria

- A user can launch one search and independently toggle blinding, decoys, planning, and summary.
- The preview states hops, sources, time, spend, and every accepted tradeoff before launch.
- Blinding or decoys cannot launch without confirm.
- Decoy hits never appear in ranked evidence or the report.
- Cancel interrupts an in-flight run.
- No `--mode`, no `safe_research.py`, no god facade.
- `python -m unittest test_safe_research.py test_bounded_contexts.py` is green.
- `AGENTS.md`, `README.md`, and `SESSION_CHECKPOINT.md` describe the new language.

---

## 12. Open decisions (resolved)

- Approach: A (lean internals) + B (rename), hard cut.
- Product: one search, explicit options, no mode enum.
- Depth: always progressive; options are budgets or declared tradeoffs.
- Quality-reducing combos: warn and require confirm.
- `meta_search` merges into `retrieval`.
- Reverse-map rehydration is not wired into reports.
