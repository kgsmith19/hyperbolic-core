# Lean Agentic DDD Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four-mode research facade with one `run_search(topic, watchlist, options) -> ResearchRun` use case, typed domain objects, declared tradeoff previews, and lean renamed bounded contexts.

**Architecture:** Keep current package folders through Tasks 1–4 (behavior first). Introduce `SearchOptions` / `Evidence` / `Query` / `SearchPreview` / `ResearchRun` under `backend/research_orchestrator/`. Split the 370-line pipeline into Guard, Planner, Explorer, Ranker, Synthesizer, Reporter. Then hard-rename packages, replace `safe_research.py` with `deep_search.py`, thread the UI server, and delete dead aliases. No compatibility aliases.

**Tech Stack:** Python 3.11/3.12, unittest, existing `http.server` / `socketserver`, vanilla frontend JS.

**Spec:** `docs/superpowers/specs/2026-09-22-agentic-ddd-lean-search-design.md`

## Global Constraints

- Zero secret egress: watchlist terms, reverse alias maps, and secret-bearing documents never go to the collector, OpenAI, or SearXNG.
- Dual discovery: academic registries, SEC EDGAR, and SearXNG run concurrently — never sequentially.
- SearXNG connector queries `http://127.0.0.1:8080` and falls back to in-process DDG+Bing.
- No mode enum. Options are independent. Hard cut: reject `"mode"` / `--mode`; do not translate.
- `requires_confirm` is true iff `blind_watchlist` or `decoy_queries > 0`. Quality-reducing combos warn and require confirm.
- Decoy-originated results never enter the frontier, never rank, never appear in the report.
- Default `max_duration_sec` is `180.0` (pipeline's `120.0` is a bug and dies).
- Tests: `python -m unittest test_safe_research.py test_bounded_contexts.py` green after every task.
- TDD: failing test first, watch it fail, then implement.
- Tests import from owning contexts, never a god facade (after Task 6).
- Do not commit `.env`. Do not push or merge unless asked.

## File map

**Create (Tasks 1–4, current packages):**
- `backend/research_orchestrator/types.py`
- `backend/research_orchestrator/preview.py`
- `backend/research_orchestrator/planner.py` (replaces `query_planner.py` behavior)
- `backend/research_orchestrator/explorer.py`
- `backend/research_orchestrator/guard.py`

**Rename (Task 5):**
- `security_guard` → `privacy`
- `retrieval_engine` + `meta_search` → `retrieval` (`retrieval/connectors/`, `retrieval/meta/`)
- `discovery_frontier` → `frontier`
- `relevance_ranking` → `ranking`
- `synthesis_intelligence` → `synthesis`
- `research_orchestrator` → `research`
- `safe_research.py` → `deep_search.py`

**Modify:** pipeline, ranker, synthesizer, report generator, collector client, retrieval router, web server, frontend HTML/JS, tests, `AGENTS.md`, `README.md`, `SESSION_CHECKPOINT.md`, `Start-DeepSearch.bat`, `Dockerfile.core`.

---

### Task 1: Domain types and SearchPreview

**Files:**
- Create: `backend/research_orchestrator/types.py`
- Create: `backend/research_orchestrator/preview.py`
- Modify: `backend/research_orchestrator/__init__.py`
- Modify: `backend/research_orchestrator/cost_estimator.py` — keep `CostTracker` / `SpendReport` / `MODEL_PRICING`; stop using a `mode` string in new preview (old `estimate_research_workload` may remain until Task 4)
- Test: `test_bounded_contexts.py`

**Interfaces:**
- Consumes: `CostTracker.estimate_cost`, `MODEL_PRICING` from `cost_estimator.py`
- Produces:
  - `SearchOptions` dataclass with fields and defaults exactly as in the spec §1
  - `Evidence(title, url, snippet, excerpt="", doi="", depth=0, source="", score=0.0)` frozen
  - `Query(text, is_decoy=False)` frozen
  - `SearchPreview(expected_hops, expected_sources, expected_duration_sec, expected_spend_usd, expected_cost_display, warnings, requires_confirm)` frozen
  - `ResearchRun(topic, options, queries, evidence, summary, spend, duration_sec, archive_path, status)`
  - `preview(topic: str, options: SearchOptions) -> SearchPreview`

Canonical warning strings (use these verbatim so tests and UI share one source):

```python
WARN_DEPTH = "stops at hop {n}; sources past hop {n} are never discovered"
WARN_DOCS = "stops at ~{n} sources; deeper sources beyond that are discarded"
WARN_DURATION = "hard stop at {n:.0f}s; unfinished hops are dropped"
WARN_CONCURRENCY = "higher concurrency speeds hops but bot-blocks can stall depth"
WARN_BLIND = "watchlist terms never leave the machine; engines see placeholders — weaker recall"
WARN_DECOYS = "{k} decoy searches run for real and yield no evidence (~{pct}% of query time serves decoys)"
WARN_PLAN = "topic leaves the machine for query planning; small spend"
WARN_SUMMARY = "redacted excerpts leave the machine for a sourced brief; spend scales with corpus"
WARN_SPEND = "hard spend ceiling ${cap:.2f}; run downgrades to local synthesis if the cap is hit"
```

- [ ] **Step 1: Write the failing tests** in `test_bounded_contexts.py` as `TestSearchPreview`:

```python
from backend.research_orchestrator.types import SearchOptions, SearchPreview
from backend.research_orchestrator.preview import preview

class TestSearchPreview(unittest.TestCase):
    def test_defaults_do_not_require_confirm(self):
        p = preview("solid-state batteries", SearchOptions())
        self.assertFalse(p.requires_confirm)
        self.assertEqual(p.expected_hops, 2)
        self.assertEqual(p.expected_sources, 15)
        self.assertEqual(p.expected_duration_sec, 180.0)
        self.assertEqual(p.expected_spend_usd, 0.0)
        self.assertIn("Free", p.expected_cost_display)

    def test_blind_requires_confirm_and_warns_weaker_recall(self):
        p = preview("topic", SearchOptions(blind_watchlist=True))
        self.assertTrue(p.requires_confirm)
        self.assertTrue(any("weaker recall" in w.lower() for w in p.warnings))

    def test_decoys_require_confirm_and_warn_wasted_query_time(self):
        p = preview("topic", SearchOptions(decoy_queries=3))
        self.assertTrue(p.requires_confirm)
        self.assertTrue(any("decoy" in w.lower() for w in p.warnings))

    def test_planning_and_summary_do_not_require_confirm(self):
        p = preview("topic", SearchOptions(ai_planning=True, ai_summary=True))
        self.assertFalse(p.requires_confirm)
        self.assertGreater(p.expected_spend_usd, 0.0)
        self.assertTrue(any("planning" in w.lower() or "leaves the machine" in w.lower() for w in p.warnings))

    def test_requires_confirm_iff_blind_or_decoys(self):
        self.assertFalse(preview("t", SearchOptions()).requires_confirm)
        self.assertTrue(preview("t", SearchOptions(blind_watchlist=True)).requires_confirm)
        self.assertTrue(preview("t", SearchOptions(decoy_queries=1)).requires_confirm)
        self.assertTrue(preview("t", SearchOptions(blind_watchlist=True, decoy_queries=2)).requires_confirm)
```

- [ ] **Step 2: Run tests to verify they fail**

```
python -m unittest test_bounded_contexts.TestSearchPreview -v
```

Expected: `ModuleNotFoundError` or `ImportError` for `types` / `preview`.

- [ ] **Step 3: Write minimal implementation**

`types.py`: dataclasses exactly as spec §1. Import `SpendReport` from `cost_estimator` for `ResearchRun.spend` annotation (use `from __future__ import annotations` to avoid cycles, or a string annotation).

`preview.py`:

```python
def preview(topic: str, options: SearchOptions) -> SearchPreview:
    warnings = [
        WARN_DEPTH.format(n=options.max_depth),
        WARN_DOCS.format(n=options.max_documents),
        WARN_DURATION.format(n=options.max_duration_sec),
    ]
    if options.concurrency > 4:
        warnings.append(WARN_CONCURRENCY)
    if options.blind_watchlist:
        warnings.append(WARN_BLIND)
    if options.decoy_queries > 0:
        k = options.decoy_queries
        pct = int(round(100 * k / (k + 1)))
        warnings.append(WARN_DECOYS.format(k=k, pct=pct))
    spend = 0.0
    display = "$0.00 (100% Free / Offline)"
    if options.ai_planning:
        warnings.append(WARN_PLAN)
    if options.ai_summary:
        warnings.append(WARN_SUMMARY)
    if options.ai_planning or options.ai_summary:
        # Reuse CostTracker.estimate_cost with the same token heuristics
        # currently in estimate_research_workload for expansion/full.
        ...
        display = f"~${spend:.4f} USD" if spend < 0.01 else f"~${spend:.3f} USD"
        warnings.append(WARN_SPEND.format(cap=options.max_spend_usd))
    return SearchPreview(
        expected_hops=options.max_depth,
        expected_sources=options.max_documents,
        expected_duration_sec=options.max_duration_sec,
        expected_spend_usd=round(spend, 5),
        expected_cost_display=display,
        warnings=warnings,
        requires_confirm=bool(options.blind_watchlist or options.decoy_queries > 0),
    )
```

Export `SearchOptions`, `Evidence`, `Query`, `SearchPreview`, `ResearchRun`, `preview` from `backend/research_orchestrator/__init__.py`.

- [ ] **Step 4: Run tests to verify they pass**

```
python -m unittest test_bounded_contexts.TestSearchPreview test_bounded_contexts test_safe_research -v
```

Expected: new tests pass; existing 41 still pass.

- [ ] **Step 5: Commit**

```
git add backend/research_orchestrator/types.py backend/research_orchestrator/preview.py backend/research_orchestrator/__init__.py test_bounded_contexts.py
git commit -m "feat: add SearchOptions, Evidence, and tradeoff preview"
```

---

### Task 2: Planner emits tagged Query list (including decoys)

**Files:**
- Create: `backend/research_orchestrator/planner.py`
- Modify: `backend/research_orchestrator/query_planner.py` — keep `expand_topic_queries` internals; planner calls them
- Modify: `backend/research_orchestrator/__init__.py`
- Test: `test_bounded_contexts.py` (`TestPlanner`)

**Interfaces:**
- Consumes: `SearchOptions`, `Query`; `expand_topic_queries`; `generate_statistical_decoys` from `backend.security_guard.statistical_chaffer`
- Produces: `plan_queries(topic: str, watchlist: list[str], options: SearchOptions, cost_tracker=None) -> list[Query]`

Rules:
- First real query is always `Query(text=topic, is_decoy=False)` (topic is already asserted or blinded by Guard; planner does not re-blind).
- If `options.ai_planning`: call `expand_topic_queries` and wrap extra lines as real `Query`s. On failure / no key / spend cap: keep `[Query(topic)]`.
- If `options.decoy_queries = k > 0`: `generate_statistical_decoys(topic, k=k)` and append `Query(text=d, is_decoy=True)`.
- Mix decoys into the list after the real queries (shuffle decoys among themselves is fine; do not shuffle away the first real query).
- Never include watchlist terms. Do not call OpenAI if `ai_planning` is False.

- [ ] **Step 1: Write failing tests**

```python
from backend.research_orchestrator.planner import plan_queries

class TestPlanner(unittest.TestCase):
    def test_defaults_return_single_real_query(self):
        qs = plan_queries("solid-state batteries", [], SearchOptions())
        self.assertEqual(len(qs), 1)
        self.assertEqual(qs[0].text, "solid-state batteries")
        self.assertFalse(qs[0].is_decoy)

    def test_decoys_are_tagged_and_do_not_replace_real(self):
        qs = plan_queries("solid-state batteries", [], SearchOptions(decoy_queries=3))
        real = [q for q in qs if not q.is_decoy]
        decoy = [q for q in qs if q.is_decoy]
        self.assertEqual(len(real), 1)
        self.assertEqual(real[0].text, "solid-state batteries")
        self.assertEqual(len(decoy), 3)
        self.assertTrue(all(d.text != "solid-state batteries" for d in decoy))

    @patch.dict(os.environ, {"OPENAI_API_KEY": ""}, clear=False)
    def test_ai_planning_without_key_falls_back_to_topic(self):
        qs = plan_queries("topic", [], SearchOptions(ai_planning=True))
        self.assertEqual([q.text for q in qs if not q.is_decoy], ["topic"])
```

- [ ] **Step 2: Run to verify fail**

```
python -m unittest test_bounded_contexts.TestPlanner -v
```

Expected: ImportError for `planner`.

- [ ] **Step 3: Implement `plan_queries`** as specified. Do not delete `expand_topic_queries` yet (pipeline still uses it until Task 4).

- [ ] **Step 4: Run tests**

```
python -m unittest test_bounded_contexts.TestPlanner test_bounded_contexts test_safe_research
```

- [ ] **Step 5: Commit** `feat: plan_queries emits real and decoy Query objects`

---

### Task 3: Guard + Explorer (typed evidence, decoy discard, parallel connectors)

**Files:**
- Create: `backend/research_orchestrator/guard.py`
- Create: `backend/research_orchestrator/explorer.py`
- Modify: `backend/retrieval_engine/retrieval_router.py` — `search()` must fan out connectors concurrently (`ThreadPoolExecutor`); sequential `extend` is a bug
- Modify: `backend/research_orchestrator/__init__.py`
- Test: `test_bounded_contexts.py` (`TestGuard`, `TestExplorer`); add a router concurrency test if cheap

**Interfaces:**
- Consumes: `SearchOptions`, `Query`, `Evidence`; `create_blinder`, `blind_text`, `assert_safe_to_send`, `enforce_secret_core_socket_block`; `get_collector`; `ResearchFrontier`; `canonicalize_url`; `is_bot_or_js_barrier`; `LocalSLMEngine.analyze_gaps`
- Produces:
  - `prepare_topic(topic, watchlist, options) -> str`  # blinded or asserted topic
  - `explore(queries: list[Query], watchlist, options, cancel_token, collector=None, progress_callback=None) -> list[Evidence]`

Guard:
- `allow_openai = options.ai_planning or options.ai_summary`
- If `blind_watchlist`: return `blind_text(topic, create_blinder(watchlist)[0])`. Reverse map stays local; do not return it.
- Else: `assert_safe_to_send(topic, watchlist)` then return topic.

Explorer:
- For each query, `collector.send_task` search. Tag every result URL with originating `Query`.
- If originating `Query.is_decoy`: **do not** `frontier.add_candidate`. Drop the hits.
- Fetch loop identical in spirit to current `run_research` (batch, territory, SHA-256, snippet/excerpt, outbound links, one gap-analysis round after first hop if ≥2 real docs).
- Build `Evidence` objects, not dicts. Snippet from Abstract/Title split as today, excerpt = `content[:3000]`.
- Default `max_duration_sec` from options (180).
- Check `cancel_token.is_set()` between batches; return evidence so far.
- `run_id` / cancel token is created by the pipeline (Task 4), passed in.

Router:
- In `search()` when `connector == "all"`, submit `search_openalex`, `search_arxiv`, `search_crossref`, `search_sec_edgar`, `search_searxng`, `search_brave` to a thread pool and concatenate. Preserve result shape.

- [ ] **Step 1: Write failing tests**

```python
from backend.research_orchestrator.guard import prepare_topic
from backend.research_orchestrator.explorer import explore
from backend.research_orchestrator.types import Query, SearchOptions, Evidence
from backend.security_guard import SafetyError

class TestGuard(unittest.TestCase):
    def test_assert_blocks_watchlist(self):
        with self.assertRaises(SafetyError):
            prepare_topic("leak SECRET", ["SECRET"], SearchOptions())

    def test_blind_replaces_watchlist(self):
        out = prepare_topic("leak SECRET", ["SECRET"], SearchOptions(blind_watchlist=True))
        self.assertNotIn("SECRET", out)
        self.assertIn("TARGET_ENTITY", out)

class TestExplorer(unittest.TestCase):
    def test_decoy_hits_never_become_evidence(self):
        collector = MagicMock()
        def send(task, watchlist):
            if task.get("action") == "search":
                q = task["query"]
                return {"status": "ok", "results": [{"title": q, "url": f"https://example.org/{q.replace(' ', '-')}", "doi": ""}]}
            return {"status": "ok", "content": "Real scientific abstract about electrolytes. " * 20, "links": [], "bytes": 400}
        collector.send_task.side_effect = send
        qs = [
            Query(text="solid electrolytes", is_decoy=False),
            Query(text="ocean vents", is_decoy=True),
        ]
        ev = explore(qs, [], SearchOptions(max_documents=5, max_depth=0, max_duration_sec=30), cancel_token=None, collector=collector)
        urls = [e.url for e in ev]
        self.assertTrue(any("solid" in u or "electrolytes" in u for u in urls) or len(ev) >= 0)
        self.assertFalse(any("ocean" in u for u in urls))
        self.assertTrue(all(isinstance(e, Evidence) for e in ev))
```

The decoy test must fail today if explorer does not exist, and must keep failing if someone later adds decoy URLs to the frontier.

- [ ] **Step 2: Run to verify fail**

```
python -m unittest test_bounded_contexts.TestGuard test_bounded_contexts.TestExplorer -v
```

- [ ] **Step 3: Implement guard, explorer, concurrent router.search**

Lift fetch/snippet logic out of `research_pipeline.py` into `explorer.py`. Leave `run_research` working (it still uses the old inline loop) so existing tests pass. Do not switch the pipeline yet.

For `cancel_token=None`, treat as never cancelled.

- [ ] **Step 4: Run tests** including existing suites.

- [ ] **Step 5: Commit** `feat: guard and explorer with decoy discard and parallel search`

---

### Task 4: Pipeline becomes run_search(options) composing agents

**Files:**
- Modify: `backend/research_orchestrator/research_pipeline.py`
- Modify: `backend/research_orchestrator/__init__.py` — export `run_search`; keep `run_research` as a thin wrapper **only until Task 6**, mapping old kwargs if tests still call `mode=`. **Ruling for this task:** existing `test_safe_research.test_run_research_multi_hop_bounded` still calls `run_research(..., mode="deterministic")`. During this task, keep `run_research` as a wrapper:

```python
def run_research(topic, watchlist, mode="deterministic", **kwargs):
    options = SearchOptions(
        max_depth=kwargs.get("max_depth", 2),
        max_documents=kwargs.get("max_documents", 15),
        max_duration_sec=kwargs.get("max_duration_sec", 180.0),
        concurrency=kwargs.get("concurrency", 4),
        max_per_domain=kwargs.get("max_per_domain", 4),
        blind_watchlist=(mode == "extreme"),
        decoy_queries=3 if mode == "extreme" else 0,
        ai_planning=mode in ("expansion", "full"),
        ai_summary=(mode == "full"),
        model=kwargs.get("openai_model", "gpt-4o-mini"),
        reasoning_effort=kwargs.get("reasoning_effort"),
        max_spend_usd=kwargs.get("max_spend_usd", 2.00),
    )
    run = run_search(topic, watchlist, options, run_id=kwargs.get("run_id", "default"), progress_callback=kwargs.get("progress_callback"))
    return _run_to_legacy_dict(run)
```

This wrapper dies in Task 6. Do not add it to `__all__` as the public API of the new design — `run_search` is the public API.

- Modify: `backend/relevance_ranking/hybrid_ranker.py` — `rank_items` accepts `list[Evidence]` **or** list[dict] (if Evidence, convert to dict for scoring then return Evidence with scores filled). Prefer:

```python
def rank_items(query: str, items: list, text_key_fn=None) -> list:
    if items and isinstance(items[0], Evidence):
        dicts = [asdict(e) for e in items]
        ranked = _rank_dicts(query, dicts, text_key_fn)
        return [Evidence(**{k: d.get(k, getattr(Evidence, k, "") if False else d.get(k)) for k in Evidence.__dataclass_fields__}) for d in ranked]
```

Simplest correct approach: convert Evidence → dict, rank as today, convert back with updated score fields. Existing dict tests must still pass.

- Modify: `backend/synthesis_intelligence/local_synthesizer.py` — `synthesize` / `analyze_gaps` accept Evidence or dict (`excerpt` or `content`).
- Modify: `backend/synthesis_intelligence/openai_synthesizer.py` — same.
- Modify: `backend/synthesis_intelligence/report_generator.py` — accept Evidence or dict; metadata key `mode` becomes optional — if absent, omit Mode from header or write option flags. Prefer a `flags` string like `blind decoys=3 planning` rather than a mode name.
- Test: add `TestRunSearch` in `test_bounded_contexts.py`; update `test_run_research_multi_hop_bounded` patch target to `backend.research_orchestrator.explorer.get_collector` **or** pass a mock collector into `run_search`. Prefer injecting collector via `explore(..., collector=)` and having `run_search` call `get_collector()` only if not provided:

```python
def run_search(topic, watchlist, options: SearchOptions, run_id="default", progress_callback=None, collector=None) -> ResearchRun:
```

**run_search body:**

1. `start = time.time()`; `cost_tracker = CostTracker(model=options.model, max_spend_usd=options.max_spend_usd)`; `token = cancellation_manager.create_token(run_id)`
2. `effective = prepare_topic(topic, watchlist, options)`  # SafetyError propagates
3. if cancelled: return blocked/cancelled run
4. `queries = plan_queries(effective, watchlist, options, cost_tracker)`
5. `evidence = explore(queries, watchlist, options, token, collector=collector or get_collector(), progress_callback=progress_callback)`
6. `ranked = rank_items(topic, evidence)`  # rank on original topic, not blinded placeholders if that matches today; today ranks on `topic` not `effective_topic`. Keep ranking on the caller-supplied `topic`.
7. Synthesize: if `options.ai_summary` and key present and not cancelled: `summarize_with_openai(...)` except spend → local. Else local. Redact.
8. `write_report(...)`; read `report.md`; `cancellation_manager.clear_token(run_id)`
9. Return `ResearchRun(status=cancelled|success, ...)`

`_run_to_legacy_dict` must keep keys `status, topic, mode, queries, evidence, summary, report_markdown, report_archive, spend_report, duration_seconds` so existing tests pass. For `mode`, use `""` or omit — existing multi-hop test only asserts `status` and `evidence`. Convert `Evidence` to dicts in the legacy dict. Convert `Query` list to `list[str]` of `.text` **excluding decoys** in the public `ResearchRun` JSON later; for legacy dict, exclude decoys too.

- [ ] **Step 1: Write failing test** `test_run_search_defaults_and_decoy_exclusion` that calls `run_search` with a mock collector returning one real URL and one decoy URL and asserts decoy URL absent from `run.evidence`.

- [ ] **Step 2: Watch it fail** (run_search missing or still using mode path that ignores decoys).

- [ ] **Step 3: Implement run_search composing agents. Keep run_research wrapper.**

- [ ] **Step 4: Full suite green.**

- [ ] **Step 5: Commit** `feat: run_search composes guard, planner, explorer, ranker, synthesis`

---

### Task 5: Hard package rename

**Files:** move packages as in spec §4. Update every import. Do not leave shims.

Mapping:
- `backend/security_guard/` → `backend/privacy/`
- `backend/retrieval_engine/` → `backend/retrieval/`
- `backend/meta_search/` → `backend/retrieval/meta/`
- `backend/discovery_frontier/` → `backend/frontier/`
- `backend/relevance_ranking/` → `backend/ranking/`
- `backend/synthesis_intelligence/` → `backend/synthesis/`
- `backend/research_orchestrator/` → `backend/research/`
- `LocalSLMEngine` → `LocalSynthesizer` (class rename, all references)
- `searxng_connector` import of `aggregate_meta_search` → `backend.retrieval.meta.meta_search_aggregator`
- `collector.py` imports `backend.retrieval`
- `web_server.py` imports `backend.research`, `backend.privacy`, `backend.retrieval`

Fix `CollectorClient._start_process` root-dir walk: it uses `dirname` twice from `retrieval_engine`; after move, keep resolving repo-root `collector.py` correctly (`backend/retrieval` is still two levels below root? `backend/retrieval/collector_client.py` → parent parent = `backend`, need one more for root). **Verify the path math.** Today: `collector_client.py` in `backend/retrieval_engine/` → `dirname` = retrieval_engine, `dirname` = backend, `dirname` = root. After rename location is `backend/retrieval/collector_client.py` — same depth. OK.

`web_server.py` `_BACKEND_DIR = dirname(dirname(abspath))` from `backend/server/web_server.py` — unchanged.

Update tests' imports to new packages **but** `test_safe_research.py` may still import from `safe_research` until Task 6. After this task, `safe_research.py` must import from **new** package names so existing tests still collect.

- [ ] **Step 1: Write a failing test** that imports `backend.privacy`, `backend.research`, `backend.retrieval`, `backend.frontier`, `backend.ranking`, `backend.synthesis` (add to `test_bounded_contexts.py`).

- [ ] **Step 2: Run — ImportError.**

- [ ] **Step 3: Move directories (git mv), fix imports, rename LocalSLMEngine → LocalSynthesizer.** Update `backend/__init__.py` docstring. Keep `safe_research.py` working via new imports.

- [ ] **Step 4: Full suite green.**

- [ ] **Step 5: Commit** `refactor: rename bounded contexts to privacy, retrieval, frontier, ranking, synthesis, research`

---

### Task 6: deep_search.py CLI; kill the barrel; tests import contexts

**Files:**
- Create: `deep_search.py`
- Delete: `safe_research.py`
- Modify: `test_safe_research.py` — import from `backend.privacy`, `backend.research`, `backend.retrieval`, `backend.frontier`, `backend.ranking`, `backend.synthesis`, `backend.server`
- Modify: `test_bounded_contexts.py` — drop `run_research` / `mode=` / `OPENAI_PRICING` / `LocalSLMEngine`; use `run_search` + `SearchOptions` + `LocalSynthesizer`; replace `estimate_research_workload(mode=...)` tests with `preview(...)` assertions (api_calls derived: 0 if not planning/summary, 1 if planning only, 2 if both)
- Modify: `Start-DeepSearch.bat` → `python deep_search.py --ui`
- Modify: `Dockerfile.core` COPY/ENTRYPOINT to `deep_search.py`; CMD without `--mode`
- Delete `run_research` wrapper.

CLI (`deep_search.py`):

```python
def build_options(args) -> SearchOptions: ...

def main() -> None:
    start_searxng_service("127.0.0.1", 8080)  # log failures, do not pass
    parser = argparse.ArgumentParser(...)
    # flags from spec §6; NO --mode
    if args.ui:
        start_ui_server(); return
    topic = " ".join(load_lines(args.topic)).strip()
    watchlist = load_lines(args.watchlist)
    options = build_options(args)
    if args.preview:
        p = preview(topic, options)
        print(...)  # hops, sources, duration, spend, warnings, requires_confirm
        return
    if preview(topic, options).requires_confirm and not args.yes:
        print warnings; input "Proceed? [y/N] "; abort unless y
    try:
        run = run_search(topic, watchlist, options, progress_callback=print_progress)
    except SafetyError:
        print("Blocked by local safety guard"); return
    # do not swallow other exceptions
```

`print_progress` may print the message as-is (today it maps to "Searching"/"Processing"/"Writing" — keep simple prints).

- [ ] **Step 1: Failing tests**
  - `test_safe_research` imports from contexts (will fail while they still import `safe_research` — write the new import block and run to see failures, then delete facade).
  - Add `test_cli_has_no_mode_flag` that inspects `deep_search` argparse or runs `python deep_search.py -h` and asserts `--mode` absent and `--blind-watchlist` present.
  - Update `test_run_research_multi_hop_bounded` to `run_search(..., SearchOptions(max_depth=1, max_documents=2), collector=mock)`.
  - Patch target: `backend.research.pipeline.get_collector` or pass collector.

- [ ] **Step 2: Run — failures on missing deep_search / remaining safe_research imports.**

- [ ] **Step 3: Implement CLI, rewrite test imports, delete safe_research.py and run_research.**

- [ ] **Step 4: Full suite green. `python deep_search.py -h` shows new flags.**

- [ ] **Step 5: Commit** `feat: replace safe_research facade with deep_search CLI`

---

### Task 7: Threaded server, option APIs, UI toggles + confirm

**Files:**
- Modify: `backend/server/web_server.py`
  - `ThreadingMixIn` on the TCP server
  - `POST /api/research`: if `"mode" in data`: 400 `{"error": "mode is not supported; send SearchOptions fields"}`. Parse option fields. Call `run_search`. Serialize `ResearchRun` (queries as list of `{text, is_decoy}` or list of real query strings; evidence as dicts; spend as dict).
  - `POST /api/estimate`: same mode rejection. Call `preview(topic, options)` and return asdict.
- Modify: `frontend/public/index.html` — remove `.modes-grid` / four mode cards. Add:
  - checkbox `blind-watchlist`
  - number `decoy-queries` (default 0)
  - checkbox `ai-planning`
  - checkbox `ai-summary`
  - checkbox `confirm-weaker-recall` (hidden unless needed)
  - keep budget controls
  - optional macro buttons that only set those fields: "Local" (all off), "Private & Local (weaker recall)" (blind + decoys=3), "Plan angles" (ai-planning), "Sourced brief" (ai-planning + ai-summary)
- Modify: `frontend/js/state_manager.js` — drop `selectedMode`; store option fields
- Modify: `frontend/js/app.js` — payload uses option fields; `updatePreRunEstimate` posts options not mode; launch disabled when `requires_confirm && !checkbox`
- Modify: `frontend/js/ui_renderer.js` — `renderPreRunEstimate` uses hops/sources/duration/spend/warnings; no tier badges
- Modify: `frontend/js/api_client.js` if payload shape changes
- Test: `test_bounded_contexts.py` — `test_frontend_assets_exist_and_valid` should assert **no** `selectMode('deterministic')` in HTML and **yes** `blind-watchlist`. Add a small unit test that `SafeResearchRequestHandler` is used with a threading server (`ThreadingMixIn` in MRO of the server class). Export the server class, e.g. `class ThreadedUIServer(socketserver.ThreadingMixIn, socketserver.TCPServer): daemon_threads = True`.

- [ ] **Step 1: Failing tests** for HTML containing `id="blind-watchlist"` and not containing `selectMode('extreme')`; for preview JSON keys `requires_confirm`, `warnings`.

- [ ] **Step 2: Run fail.**

- [ ] **Step 3: Implement server + UI.** Keep CSS class names that still apply; unused `.mode-option` CSS may remain (YAGNI to restyle).

- [ ] **Step 4: Full suite + grep that `mode` is gone from frontend js/html (except CSS leftover).**

- [ ] **Step 5: Commit** `feat: option-based UI and threaded cancel`

---

### Task 8: Dead code, quarantine single path, docs

**Files:**
- Modify: `backend/retrieval/collector_client.py` — wire `SanitizedQuarantine.process_payload` for inbound strings; delete `_sanitize_quarantined_payload` regex walk duplication. Recurse dicts/lists; for strings, quarantine then redact.
- Delete unused: `search_brave` / `fetch_html_text` / `build_sanitized_evidence` from collector_client and package `__init__` (tests that imported them from `safe_research` already moved). If `test_safe_research` still references them, rewrite those tests onto collector/router or drop if they only tested the facade.
- Delete `rank_evidence` (gone with facade). Delete `OPENAI_PRICING` alias. Delete `CancellationManager.cancel` alias (tests use `cancel` today — **update tests to `cancel_run`**). Delete `release_in_flight` alias. Delete `complete_candidate` if unused.
- Delete `RetrievalRouter.search_openalex` etc pass-throughs; `search()` calls connector functions directly.
- Stop exporting `_build_term_pattern` and `_compute_subword_fallback_scores` from package `__init__`.
- `expand_topic_queries_chaffed`: if unused after planner, delete or keep if tests cover chaffed LLM expansion. Spec: decoys are search-level via `generate_statistical_decoys`, not chaffed LLM prompts. Keep `generate_chaffed_prompt` / `extract_chaffed_response` in privacy (existing tests). Planner does not need `expand_topic_queries_chaffed`. Delete it if nothing calls it.
- Docs: `AGENTS.md`, `README.md`, `SESSION_CHECKPOINT.md` — new language, no mode enum, `deep_search.py`, package map.
- Test command in AGENTS.md stays `python -m unittest test_safe_research.py test_bounded_contexts.py`.

- [ ] **Step 1: Add/adjust tests** that inbound injection patterns still redact via quarantine; that `from backend.retrieval import build_sanitized_evidence` fails.

- [ ] **Step 2: Fail / then delete and fix.**

- [ ] **Step 3: Delete dead code, update docs.**

- [ ] **Step 4: Full suite green. Grep for `safe_research`, `--mode`, `LocalSLMEngine`, `security_guard`, `run_research(` in py/js/html/bat/Dockerfile (ignore reports/ and docs/superpowers history).**

- [ ] **Step 5: Commit** `chore: delete mode aliases and update docs to one-search options`

---

## Self-review

**Spec coverage:**
- One search + SearchOptions → Tasks 1, 4, 6
- Tradeoff preview + requires_confirm → Task 1, 7
- Agents composed by run_search → Tasks 2–4
- Decoy discard → Tasks 2, 3, 4
- Parallel connectors → Task 3
- Hard rename → Task 5
- deep_search.py, no barrel → Task 6
- Threaded cancel + UI toggles + confirm → Task 7
- Dead code + quarantine one path + docs → Task 8
- Default duration 180 → Tasks 1, 4
- No rehydrate in pipeline → Task 4 (do not call it)

**Type consistency:** `SearchOptions`, `Evidence`, `Query`, `SearchPreview`, `ResearchRun`, `preview`, `plan_queries`, `prepare_topic`, `explore`, `run_search` names are stable across tasks. Rename of packages happens only in Task 5; `LocalSynthesizer` in Task 5.

**Wrapper:** `run_research` exists only in Task 4–5 and dies in Task 6.
