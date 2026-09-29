# Durable Research Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-only, privacy-safe durable ledger that can checkpoint, explain, and resume bounded Deep Search runs without changing the collector boundary or default search behavior.

**Architecture:** The secret-core process owns a versioned `RunStore` that atomically snapshots a sanitized manifest and appends sanitized lifecycle/evidence JSONL records. `ResearchFrontier` gains an explicit data-only snapshot/restore interface, while the explorer receives optional checkpoint hooks and a deterministic `InformationGainTracker`; existing callers retain their current in-memory path. `run_search` and `resume_search` compose those additive pieces, then expose additive run metadata through CLI and local HTTP.

**Tech Stack:** Python 3.11/3.12 standard library (`dataclasses`, `json`, `pathlib`, `tempfile`, `hashlib`, `datetime`), `unittest`, existing privacy redactor/assertion, existing collector IPC, `ResearchFrontier`, and threaded local HTTP server.

**Spec:** `docs/superpowers/specs/2026-09-28-durable-research-ledger-design.md`

## Global Constraints

- Work only in `C:/code/deep-search/.worktrees/feat/research-architecture-upgrades` on `feat/research-architecture-upgrades`; never modify the root main checkout.
- Preserve zero-secret-egress: do not persist or send raw watchlist terms, reverse alias maps, unredacted network payloads, collector handles, locks, or process state.
- Keep collector subprocess/IPC isolation, quarantine/redaction, concurrent connector/search/fetch behavior, and local-first/no-key operation unchanged.
- `ResearchFrontier` remains the authority for depth, document, byte, duration, per-domain, URL/DOI/content-hash, and in-flight limits.
- Persist only from the secret core after `redact` plus `assert_safe_to_send`; ledger files are local-only under `research_runs/<run-id>/`.
- Manifest writes must be atomic replacement; JSONL appends must flush after every record; manifest corruption fails closed and only a malformed *final* JSONL line is recoverable.
- Resume always opens a fresh collector pool and never serializes a collector, lock, socket, cancellation token, or raw response body.
- Defaults preserve today’s behavior: information-gain stopping is opt-in, and all existing `run_search`, CLI, report archive, and HTTP fields remain compatible.
- Use offline fake collectors/mocks at the existing collector boundary; do not issue live network calls in tests.
- Keep the full required verification command green before a completion or merge claim:
  `python -m unittest test_safe_research.py test_bounded_contexts.py test_ai_search_expansion.py test_deep_expansion.py test_ultra_deep.py test_server_stream.py`.

## Review Focus

1. A watchlist value embedded in a topic, fetched body, provider error, or event payload is redacted before *every* manifest/JSONL write; cover in Task 1.
2. A crash after a batch has reserved URLs requeues each stale in-flight item once, retains priority/dedupe state, and does not refetch accepted URLs; cover in Tasks 2 and 4.
3. A truncated trailing event is tolerated, but an invalid manifest/schema/version cannot silently resume; cover in Task 1.
4. A low-gain threshold never stops before the configured minimum evidence or ahead of a queued higher-priority citation candidate; cover in Task 3.
5. Resume and HTTP/CLI metadata are additive: old request payloads, old `ResearchRun` construction sites, cancellation, and report archives still work; cover in Tasks 4 and 5.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `backend/research/run_store.py` | Versioned local run layout, safe serialization, atomic manifest writes, JSONL recovery, and checkpoint/result records. |
| `backend/research/information_gain.py` | Deterministic accepted-batch novelty accounting and opt-in low-gain decision. |
| `backend/frontier/priority_frontier.py` | Data-only frontier export/import, including once-only stale in-flight requeue. |
| `backend/research/types.py` | Additive `SearchOptions` controls and `ResearchRun` ledger metadata. |
| `backend/research/explorer.py` | Optional restored-frontier/evidence inputs, batch-boundary checkpoint callbacks, provider outcome hooks, and information-gain termination. |
| `backend/research/research_pipeline.py` | New-run/resume orchestration, phase/terminal handling, ledgered planning/ranking/reporting, and remove the stale `ranked[:8]` synthesis cap. |
| `backend/research/__init__.py` | Public additive exports for `resume_search`, `RunStore`, and checkpoint types. |
| `backend/server/web_server.py` | Local resume endpoint and additive response fields without changing `/api/research` SSE semantics. |
| `deep_search.py` | Mutually exclusive new-run/resume CLI path and run-id/status output. |
| `test_durable_research_ledger.py` | New offline unit/integration regression coverage for store, frontier, gain, interruption/resume, failures, privacy, and synthesis limit. |
| `test_server_stream.py` | HTTP resume and additive result-payload coverage. |
| `docs/architecture/research-pipeline.md` | Current/target source-inspected architecture map and trust boundaries. |
| `docs/research-reference-gap-matrix.md` | Expanded inspected-source comparison and staged recommendations. |
| `docs/decision-log/2026-09-28-durable-research-ledger.md` | Concise accepted decisions and rejected alternatives. |
| `README.md` | User-facing CLI/API run-ID, inspection, ledger location, and resume documentation if this project’s existing usage guide is the public entry point; otherwise update the existing user-facing CLI/API document found during Task 5. |

### Task 1: Build the Privacy-Safe Run Store

**Files:**
- Create: `backend/research/run_store.py`
- Create: `test_durable_research_ledger.py`
- Modify: `backend/research/types.py`
- Modify: `backend/research/__init__.py`

**Interfaces:**
- Consumes: `SearchOptions`, `Evidence`, `redact(value, watchlist)`, and `assert_safe_to_send(value, watchlist)`.
- Produces: `RunCheckpoint(run_id: str, status: str, phase: str, stop_reason: str | None, ledger_path: str)`; `RunStore(root: str | Path = "research_runs")`; `create`, `load`, `checkpoint`, `append_evidence`, and `finish` as defined in the spec.
- Later tasks call `store.create(run_id, topic, options, watchlist)`, `store.load(run_id, watchlist)`, `store.checkpoint(phase, payload, watchlist)`, `store.append_evidence(evidence, watchlist)`, and `store.finish(status, stop_reason, watchlist)` only in the secret core.

- [ ] **Step 1: Write failing store/privacy/recovery tests**

Add `TestRunStore` to `test_durable_research_ledger.py`, using `tempfile.TemporaryDirectory()` and `FAKE_SECRET = "LEDGER-SECRET-721"`. Test the public contract rather than filesystem implementation details:

```python
def test_create_writes_a_sanitized_versioned_manifest_and_ordered_events(self):
    with tempfile.TemporaryDirectory() as root:
        store = RunStore(root)
        checkpoint = store.create(
            "run-1", "Research LEDGER-SECRET-721", SearchOptions(), [FAKE_SECRET]
        )
        store.checkpoint("planned", {"queries": ["LEDGER-SECRET-721 review"]}, [FAKE_SECRET])
        manifest = json.loads(Path(checkpoint.ledger_path, "manifest.json").read_text())
        events = [json.loads(line) for line in Path(checkpoint.ledger_path, "events.jsonl").read_text().splitlines()]
    self.assertEqual(manifest["schema_version"], 1)
    self.assertEqual(manifest["phase"], "planned")
    self.assertNotIn(FAKE_SECRET, json.dumps([manifest, events]))
    self.assertEqual([event["sequence"] for event in events], list(range(1, len(events) + 1)))
```

Also add tests that (a) `append_evidence(Evidence(title="LEDGER-SECRET-721", url="https://example.org/1", snippet="safe", excerpt="LEDGER-SECRET-721"), watchlist)` never writes the secret to `evidence.jsonl`, (b) `load` ignores an invalid final `events.jsonl` line but retains earlier events, (c) a malformed `manifest.json` and an unsupported `schema_version` each raise `RunStoreError` with an actionable message, and (d) `finish("cancelled", "cancelled", watchlist)` records exactly one terminal event and refuses an invalid phase/status/stop-reason combination.

- [ ] **Step 2: Run the focused tests and verify they fail for missing ledger symbols**

Run: `python -m unittest test_durable_research_ledger.TestRunStore -v`

Expected: FAIL with import/attribute errors for `RunStore`, `RunStoreError`, and `RunCheckpoint`, not a fixture failure.

- [ ] **Step 3: Add additive domain types and minimal safe store implementation**

In `backend/research/types.py`, add `low_information_gain_rounds: int = 0` and `low_information_gain_min_documents: int = 0` to `SearchOptions`, where a threshold of `0` disables the feature. Add optional defaulted fields to the end of `ResearchRun`:

```python
run_id: str = ""
stop_reason: str | None = None
ledger_path: str = ""
phase: str = "completed"
```

Create `backend/research/run_store.py` with:

```python
@dataclass(frozen=True)
class RunCheckpoint:
    run_id: str
    status: str
    phase: str
    stop_reason: str | None
    ledger_path: str

class RunStoreError(RuntimeError):
    pass

class RunStore:
    SCHEMA_VERSION = 1
```

Implement these exact methods: `create(run_id: str, topic: str, options: SearchOptions, watchlist: list[str]) -> RunCheckpoint`; `load(run_id: str, watchlist: list[str]) -> dict`; `checkpoint(phase: str, payload: dict, watchlist: list[str]) -> None`; `append_evidence(evidence: Evidence, watchlist: list[str]) -> None`; and `finish(status: str, stop_reason: str, watchlist: list[str]) -> None`.

Use a recursive `_sanitize(value, watchlist)` that redacts every string, recursively preserves primitive/list/dict data, then calls `assert_safe_to_send` on the complete serialized value. Reject unknown run IDs and path-traversal-like IDs by resolving the target and requiring it remain under `root`; generate no implicit raw-topic cache. Serialize options with `dataclasses.asdict`, evidence with `asdict`, and queries as `{text, is_decoy}` only after sanitization.

Write each manifest to a same-directory `NamedTemporaryFile(delete=False)`, call `flush()` and `os.fsync()`, then `os.replace(temp_name, manifest_path)`. Append one compact JSON object per line to JSONL, flush, and `os.fsync()`. Keep `latest_event_sequence` in the manifest and update it atomically after the corresponding event append. `load` must parse all valid events, ignore only a `JSONDecodeError` on the final non-empty line, and reject malformed earlier lines. `finish` must validate one of the spec terminal status/stop reason pairs and write the `completed` phase/status/stop reason snapshot plus one `finished` event.

Export `RunCheckpoint`, `RunStore`, and `RunStoreError` in `backend/research/__init__.py`; do not import any retrieval client into the store.

- [ ] **Step 4: Run focused tests and the two affected existing contexts**

Run: `python -m unittest test_durable_research_ledger.TestRunStore test_safe_research.py test_bounded_contexts.py -v`

Expected: PASS. Confirm the generated temporary ledger contains redaction markers but no `LEDGER-SECRET-721`.

- [ ] **Step 5: Commit the independently testable store slice**

```bash
git add backend/research/run_store.py backend/research/types.py backend/research/__init__.py test_durable_research_ledger.py
git commit -m "feat: add privacy-safe research run store"
```

### Task 2: Serialize and Restore the Bounded Frontier

**Files:**
- Modify: `backend/frontier/priority_frontier.py`
- Modify: `test_durable_research_ledger.py`

**Interfaces:**
- Consumes: existing `FrontierItem`, limits, queue, visited URL/DOI/content-hash sets, domain counters, byte/document counters, and elapsed wall-clock time.
- Produces: `ResearchFrontier.export_state() -> dict` and `ResearchFrontier.from_state(state: dict) -> ResearchFrontier`.
- Later tasks call `RunStore.checkpoint("fetching", {"frontier": state}, watchlist)` and seed `explore(queries, watchlist, options, frontier_state=state)`.

- [ ] **Step 1: Write failing frontier snapshot/restore tests**

Add tests that create a frontier with distinct candidate priorities, pop two items to make them in-flight, record one successful document, export/import, and assert:

```python
restored = ResearchFrontier.from_state(frontier.export_state())
self.assertEqual([item.url for item in restored.pop_next_batch(2)],
                 ["https://example.org/inflight-high", "https://example.org/queued-mid"])
self.assertEqual(restored.documents_collected, 1)
self.assertIn(existing_hash, restored.content_hashes)
self.assertFalse(restored.add_candidate("https://example.org/accepted", priority=99))
```

Use separate domains and assert a stale in-flight candidate is requeued exactly once at its original priority, the restored `in_flight_urls` is empty, per-domain capacity remains correct, DOI dedupe remains correct, and a malformed/missing state field raises `ValueError` rather than creating an unbounded frontier. Patch `time.time` around export/import to assert elapsed duration is preserved without serializing `start_time` as a wall timestamp.

- [ ] **Step 2: Run the focused frontier tests and verify they fail**

Run: `python -m unittest test_durable_research_ledger.TestFrontierPersistence -v`

Expected: FAIL because `export_state` and `from_state` are absent.

- [ ] **Step 3: Implement data-only export/import without weakening limits**

Add an `in_flight_items: dict[str, FrontierItem]` field in `ResearchFrontier.__init__`; populate it when `pop_next_batch` reserves a candidate and remove it in both `record_document` and `release_candidate`. Under the existing lock, `export_state` must return only JSON primitives:

```python
{
    "version": 1,
    "limits": {
        "max_depth": self.max_depth,
        "max_documents": self.max_documents,
        "max_bytes_budget": self.max_bytes_budget,
        "max_per_domain": self.max_per_domain,
        "max_duration_sec": self.max_duration_sec,
    },
    "elapsed_sec": max(0.0, time.time() - self.start_time),
    "total_bytes_consumed": self.total_bytes_consumed,
    "documents_collected": self.documents_collected,
    "queue": [asdict(item) for item in self.queue],
    "stale_in_flight": [asdict(item) for item in self.in_flight_items.values()],
    "visited_urls": sorted(self.visited_urls),
    "visited_dois": sorted(self.visited_dois),
    "content_hashes": sorted(self.content_hashes),
    "domain_counts": dict(self.domain_counts),
}
```

`from_state` validates exact primitive types/ranges and a recognized version, reconstructs a fresh `ResearchFrontier`, restores `start_time = time.time() - elapsed_sec`, then combines `queue` and `stale_in_flight` by URL. Requeue stale in-flight entries once, preserving priority and rejecting a stale entry if it is already accepted/visited only because it is an accepted URL—not merely because it was reserved. Do not restore locks, active workers, or an in-flight set. Sort queue with the same descending-priority order used by `add_candidate`; preserve equal-priority arrival order from the snapshot.

- [ ] **Step 4: Run focused and existing frontier regressions**

Run: `python -m unittest test_durable_research_ledger.TestFrontierPersistence test_safe_research.py test_bounded_contexts.py -v`

Expected: PASS, including existing territory-reservation and domain-refund tests.

- [ ] **Step 5: Commit the frontier slice**

```bash
git add backend/frontier/priority_frontier.py test_durable_research_ledger.py
git commit -m "feat: persist bounded frontier state"
```

### Task 3: Add Deterministic Information-Gain Stopping and Explorer Hooks

**Files:**
- Create: `backend/research/information_gain.py`
- Modify: `backend/research/explorer.py`
- Modify: `test_durable_research_ledger.py`

**Interfaces:**
- Consumes: accepted `list[Evidence]`, `ResearchFrontier`, and options `low_information_gain_rounds`/`low_information_gain_min_documents`.
- Produces: `GainObservation(accepted_documents: int, new_domains: int, new_dois: int, new_content_hashes: int, resolved_concepts: int, low_gain: bool)` and `InformationGainTracker.observe_batch(evidence: list[Evidence], frontier: ResearchFrontier) -> GainObservation`, `should_stop(minimum_documents: int) -> bool`.
- Explorer additive parameters: `frontier_state: dict | None = None`, `prior_evidence: list[Evidence] | None = None`, `checkpoint_callback: Callable[[str, dict], None] | None = None`, and `stop_callback: Callable[[str], None] | None = None`; existing callers may omit all four.

- [ ] **Step 1: Write failing gain and explorer-hook tests**

Add deterministic unit tests with no network:

```python
tracker = InformationGainTracker(consecutive_round_limit=2)
tracker.observe_batch([Evidence(url="https://a.example/1", excerpt="first unique body")], frontier)
self.assertFalse(tracker.should_stop(minimum_documents=2))
tracker.observe_batch([], frontier)
self.assertFalse(tracker.should_stop(minimum_documents=1))
tracker.observe_batch([], frontier)
self.assertTrue(tracker.should_stop(minimum_documents=1))
```

Also test that a new canonical domain, a new DOI, or a new normalized excerpt hash resets the consecutive low-gain count; duplicate-only/empty batches increment it; and `consecutive_round_limit=0` never stops. Create a one-worker fake collector flow with repeated duplicate content and assert the callback receives sanitized `search`, `fetch`, `evidence`, and `frontier` batch records, `stop_callback("low_information_gain")` fires only after the configured threshold/minimum, and a queued `FrontierItem(source_url="citations:references", priority=55.0)` is fetched before stopping.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `python -m unittest test_durable_research_ledger.TestInformationGain test_durable_research_ledger.TestExplorerCheckpoints -v`

Expected: FAIL because the tracker and explorer hook parameters do not exist.

- [ ] **Step 3: Implement the tracker and batch-boundary hooks**

Create `InformationGainTracker` as local, deterministic state only. Seed prior URLs/domains/DOIs/content hashes from `prior_evidence`; use `urllib.parse.urlparse(url).netloc.lower()` and SHA-256 of normalized `excerpt or snippet` to calculate novelty. For the first increment, set `resolved_concepts=0` unless existing `EvidenceGraph.coverage_gaps` can be calculated from already-sanitized accepted evidence in the secret core without changing query fan-out; keep that calculation local and deterministic. An observation is low gain only if it has no accepted evidence and adds no new domain or resolved concept. Record new DOI/hash counters for diagnostics even though a newly accepted document is inherently non-low-gain.

In `explore`, select `ResearchFrontier.from_state(frontier_state)` when supplied, otherwise construct the existing frontier. Start `collected` with `prior_evidence` after normalizing to `Evidence`; do not issue search requests for persisted queries again when a restored frontier already has queue work. Preserve concurrent search and fetch executors. At each completed search/fetch/batch boundary, call the optional callback with *only* a local safe record: action/provider identifier, status/error text, newly accepted `Evidence`, and `frontier.export_state()`; never pass a task dictionary, collector, watchlist, or raw response through this callback.

After each completed fetch batch, call `observe_batch(batch_accepted, frontier)`. If the option threshold is positive, the configured minimum has been met, and the tracker is eligible to stop, first scan the queued frontier for an unprocessed `source_url` beginning `"citations:"` whose priority exceeds the next ordinary candidate; continue instead when such a citation candidate exists. Otherwise call `stop_callback("low_information_gain")`, checkpoint the frontier, and break. A cancellation still wins and follows the existing safe batch-boundary behavior.

- [ ] **Step 4: Run focused explorer and regression tests**

Run: `python -m unittest test_durable_research_ledger.TestInformationGain test_durable_research_ledger.TestExplorerCheckpoints test_deep_expansion.py test_bounded_contexts.py -v`

Expected: PASS. Confirm the legacy explorer path still runs without any callback and the low-gain feature remains disabled at default options.

- [ ] **Step 5: Commit the information-gain/explorer slice**

```bash
git add backend/research/information_gain.py backend/research/explorer.py test_durable_research_ledger.py
git commit -m "feat: checkpoint exploration and stop low-gain runs"
```

### Task 4: Orchestrate Durable New and Resumed Runs

**Files:**
- Modify: `backend/research/research_pipeline.py`
- Modify: `backend/research/types.py`
- Modify: `backend/research/__init__.py`
- Modify: `test_durable_research_ledger.py`

**Interfaces:**
- Consumes: `RunStore`, `RunCheckpoint`, `RunStoreError`, `ResearchFrontier` state, explorer callbacks, and serialized safe `Query`/`Evidence` records.
- Produces: `run_search(topic: str, watchlist: list[str], options: SearchOptions, run_id: str | None = None, progress_callback=None, collector=None, ledger_root: str = "research_runs") -> ResearchRun` and `resume_search(run_id: str, watchlist: list[str], *, progress_callback=None, collector=None, ledger_root: str = "research_runs") -> ResearchRun`.
- Later tasks use: additive `ResearchRun.run_id`, `.phase`, `.stop_reason`, `.ledger_path` and `run_to_dict` fields.

- [ ] **Step 1: Write failing interruption/resume/failure/cancellation/synthesis-limit tests**

Add a fake collector that returns a first accepted source, then raises a purpose-built `InterruptedError` before the next safe batch. Assert that `run_search("topic", [], options, run_id="resume-1", collector=first_collector, ledger_root=temp_root)` raises/returns the documented interrupted result only after its first evidence and frontier checkpoint are durable. Then call `resume_search("resume-1", [], collector=fresh_fake, ledger_root=temp_root)` and assert the final evidence has both URLs, the accepted first URL was never fetched by the second collector, a fresh collector was used, and `manifest["status"] == "success"` with `stop_reason == "completed"`.

Add separate tests that a search/fetch provider error produces a sanitized provider/fetch event yet still returns other accepted evidence; cancellation records `status="cancelled"` and `stop_reason="cancelled"` after the safe batch and retains partial-report behavior; completed success runs reject resume with `RunStoreError`; and `run_to_dict` retains old keys plus `run_id`, `phase`, `stop_reason`, and `ledger_path`.

Pin the known synthesis regression with 12 ranked safe evidence items and a patched `_synthesize`:

```python
with patch("backend.research.research_pipeline._synthesize", return_value="brief") as synthesize:
    run_search("topic", [], options, collector=collector)
self.assertEqual(len(synthesize.call_args.args[1]), 12)
```

Use `max_gap_rounds=0`, `max_depth=0`, and no remote model for deterministic collection.

- [ ] **Step 2: Run focused pipeline tests and verify they fail**

Run: `python -m unittest test_durable_research_ledger.TestDurablePipeline -v`

Expected: FAIL because resume orchestration/metadata does not exist and the synthesis assertion receives only 8 items.

- [ ] **Step 3: Implement phase-safe orchestration and resume**

Refactor `run_search` through a private `_run_from_checkpoint` helper rather than duplicating ranking/synthesis/reporting. New runs generate a UUID run ID only when the caller did not provide one; call `prepare_topic` before persisting, create `RunStore(ledger_root)`, and create a manifest using the redacted effective topic, immutable options, and `created` phase. Checkpoint planned sanitized query records before exploration, then route explorer records to `RunStore.checkpoint`/`append_evidence` at batch boundaries.

Use the phase order from the spec (`created`, `planned`, `searching`, `fetching`, `expanding`, `ranking`, `synthesizing`, `reporting`, `completed`), writing the next phase/event before an externally visible progress message. Map ordinary completion to `success/completed`; cancellation to `cancelled/cancelled`; an uncaught interruption to `interrupted/internal_error` only after a frontier checkpoint; and unrecoverable no-provider-path failure to `failed/provider_failure`. Preserve partial evidence/report generation for cancellation. Sanitize exception names/messages before recording and re-raise unexpected programming errors after persisting a failed terminal state so existing callers retain error visibility.

`resume_search` loads the manifest/evidence/events with the supplied watchlist, rejects only `success`/`completed`, reconstructs `SearchOptions(**manifest["options"])`, `Query` and `Evidence` values, and invokes `_run_from_checkpoint` with `frontier_state`. It uses the persisted safe effective topic/queries—not a raw original topic—and starts a fresh cancellation token and collector pool. Do not send any manifest or ledger path to the collector.

Make `ResearchRun` return the run ID, current terminal phase, stop reason, and ledger directory on all durable paths; retain defaults in `_empty_run` for old callers. Extend `run_to_dict` additively. Replace `ranked[:8]` with `ranked` when invoking `_synthesize`; `_format_sources` already enforces the 25-source presentation cap, so ranking/synthesis can receive up to `rerank_keep` evidence without changing output limits.

- [ ] **Step 4: Run focused pipeline tests and relevant legacy suite**

Run: `python -m unittest test_durable_research_ledger.TestDurablePipeline test_deep_expansion.py test_ultra_deep.py test_safe_research.py -v`

Expected: PASS, including interruption/resume without duplicate fetch and the 12-source handoff to `_synthesize`.

- [ ] **Step 5: Commit the orchestration slice**

```bash
git add backend/research/research_pipeline.py backend/research/types.py backend/research/__init__.py test_durable_research_ledger.py
git commit -m "feat: resume durable research runs"
```

### Task 5: Expose Resume Through CLI, HTTP, and Documentation

**Files:**
- Modify: `deep_search.py`
- Modify: `backend/server/web_server.py`
- Modify: `test_server_stream.py`
- Modify: `test_durable_research_ledger.py`
- Create: `docs/architecture/research-pipeline.md`
- Create: `docs/research-reference-gap-matrix.md`
- Create: `docs/decision-log/2026-09-28-durable-research-ledger.md`
- Modify: `README.md` or the discovered existing user-facing CLI/API document

**Interfaces:**
- Consumes: `resume_search`, additive `run_to_dict` fields, and the existing local-only server request handler.
- Produces: CLI `--resume RUN_ID`, `--run-id RUN_ID`, `--ledger-root PATH`, `--low-information-gain-rounds N`, `--low-information-gain-min-documents N`; HTTP `POST /api/resume`; unchanged `/api/research` SSE plus additive result fields.

- [ ] **Step 1: Write failing CLI/HTTP/documentation tests**

Add parser tests that `--resume run-42` is accepted without `--topic`, `--run-id run-42` is accepted for a new run, and `--resume` combined with `--topic` or planning-only new-run controls is rejected with `parser.error`. Assert the new low-gain flags map exactly to `SearchOptions` and default to disabled.

In `test_server_stream.py`, patch `web_server.resume_search`, issue a local `POST /api/resume` JSON body `{"run_id":"run-42","watchlist":""}`, and assert SSE progress/result ordering remains valid and the result includes `run_id`, `phase`, `stop_reason`, and `ledger_path`; assert malformed JSON or missing run ID receives a safe 400 JSON error. Keep existing `/api/research` tests untouched except for asserting its old result fixture serializes additive fields.

- [ ] **Step 2: Run focused interface tests and verify they fail**

Run: `python -m unittest test_durable_research_ledger.TestLedgerCLI test_server_stream.TestResearchResumeHTTP -v`

Expected: FAIL because flags and `/api/resume` do not exist.

- [ ] **Step 3: Implement additive local interfaces**

In `deep_search.py`, add `--run-id`, `--resume`, `--ledger-root`, and both low-gain controls. Validate that `--resume` selects `resume_search` and cannot be combined with a topic-file new run; load the watchlist locally in both paths. For a new run, pass `run_id`, `ledger_root`, and options to `run_search`. Print run ID, terminal status/stop reason, ledger path, source count, and existing report path. Do not print watchlist data or event payloads.

In `backend/server/web_server.py`, import `resume_search`. Add `POST /api/resume` using the existing local SSE helper pattern: parse only `run_id`, `watchlist`, and optional `ledger_root` (defaulting to `_ROOT_DIR/research_runs`); reject blank/non-string run IDs and malformed payloads before beginning SSE; call `resume_search` with a progress callback and emit `{ "type": "result", **run_to_dict(run) }`. Keep `/api/research` request shape, status, stream framing, cancellation behavior, and old response keys unchanged. Parse low-gain fields in `_options_from_payload` for new-run HTTP callers.

Write docs from source inspection, not README claims:

- `docs/architecture/research-pipeline.md`: show current/target call flow, secret-core/collector boundary, owned state, local file layout, checkpoint boundaries, resume flow, and explicitly state the collector never reads a ledger.
- `docs/research-reference-gap-matrix.md`: expand the approved spec’s matrix with inspected repo path/symbol, Deep Search current state, adopted/deferred decision, benefit, and risk; include the DR-Tulu repository-not-found limitation without drawing conclusions.
- `docs/decision-log/2026-09-28-durable-research-ledger.md`: record JSON+JSONL over SQLite, sanitized evidence only, batch checkpoints, deterministic local gain, no subagents, frontier adapter not replacement, separate reports, and the rejected alternatives/rationale.
- User documentation: describe local `research_runs/<run-id>/` files, how to start with `--run-id`, resume with `--resume`, inspect `manifest.json`/JSONL safely, terminal statuses/reasons, and that resuming needs the same local watchlist while raw watchlist terms are never persisted.

- [ ] **Step 4: Run focused interface/documentation regressions**

Run: `python -m unittest test_durable_research_ledger.TestLedgerCLI test_server_stream.py test_bounded_contexts.py test_ultra_deep.py -v`

Expected: PASS. Manually inspect the new docs for the required source paths/symbol names and confirm no watchlist fixture appears in documentation or HTTP error output.

- [ ] **Step 5: Commit the interface and documentation slice**

```bash
git add deep_search.py backend/server/web_server.py test_server_stream.py test_durable_research_ledger.py docs README.md
git commit -m "feat: expose research ledger resume interfaces"
```

### Task 6: Full Regression, Requirement Trace, and Branch Review

**Files:**
- Modify only if required by a failing test or a documented requirement gap discovered during this task.

**Interfaces:**
- Consumes: the approved design, this plan, final diff, and all previous test suites.
- Produces: verification evidence and a requirement-to-test trace in the implementation summary/PR description; no opportunistic subsystem rewrite.

- [ ] **Step 1: Run the full required verification command**

Run:

```bash
python -m unittest test_safe_research.py test_bounded_contexts.py test_ai_search_expansion.py test_deep_expansion.py test_ultra_deep.py test_server_stream.py test_durable_research_ledger.py
```

Expected: all tests pass; any environment-dependent Playwright tests remain explicitly skipped rather than hidden.

- [ ] **Step 2: Inspect the final diff for privacy and scope regressions**

Run:

```bash
git diff main...HEAD --check
git diff main...HEAD -- backend/privacy backend/retrieval/collector_client.py collector.py
git status --short
git log --oneline main..HEAD
```

Expected: no whitespace errors; collector boundary files have no unintended changes; only planned files are modified; commits correspond to the completed slices.

- [ ] **Step 3: Trace every acceptance criterion to evidence**

Create a final checklist in the task/PR summary mapping: interruption/resume → `TestDurablePipeline`; no persisted watchlist → `TestRunStore`; old suites → full command; duplicate/low-gain/citation priority → `TestInformationGain`/`TestExplorerCheckpoints`; CLI/HTTP additive metadata → `TestLedgerCLI`/`TestResearchResumeHTTP`; 25-source cap correction → synthesis handoff test plus existing `_format_sources` test. If any mapping is missing, add a failing test first, then make the smallest production correction and rerun the focused test.

- [ ] **Step 4: Commit only final test/doc fixes if necessary**

```bash
git add <only-files-required-by-the-final-fix>
git commit -m "test: verify durable research ledger regressions"
```

Skip this step when the worktree is clean after Step 3; do not create an empty commit.

## Plan Self-Review

- **Spec coverage:** Tasks 1–2 implement the local versioned manifest/event/evidence ledger and safe frontier restoration. Task 3 adds deterministic opt-in gain stopping at safe batch boundaries. Task 4 persists sanitized query/evidence/provider/fetch/terminal transitions, resumes with fresh collectors, introduces explicit phases/statuses/reasons, and fixes the `ranked[:8]` regression. Task 5 supplies CLI, HTTP, API metadata, architecture/gap/decision/user docs. Task 6 checks every acceptance criterion and all current regressions.
- **Placeholder scan:** No `TODO`, `TBD`, “implement later,” or generic “add tests/error handling” steps remain; each task specifies the concrete API, test behavior, command, and expected outcome.
- **Type consistency:** `RunCheckpoint`, `RunStore`, `ResearchFrontier.export_state()` / `ResearchFrontier.from_state(state)`, `InformationGainTracker`, explorer callbacks, `resume_search`, and the `ResearchRun` additive fields use the same names throughout.
- **Review focus coverage:** Task 1 covers redaction and corrupt/truncated persistence; Task 2 covers stale in-flight restoration; Task 3 covers minimum/priority low-gain guards; Tasks 4–5 cover resume/API/CLI backward compatibility.
`