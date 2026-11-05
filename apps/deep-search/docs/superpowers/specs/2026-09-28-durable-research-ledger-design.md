# Durable Research Ledger and Evidence-Driven Continuation Design

## Purpose

Deep Search already performs bounded, privacy-preserving recursive retrieval. This design adds a durable, local-only research ledger so a run can survive interruption, explain its stopping decision, and resume without repeating completed work. It establishes the persistence and evidence-provenance substrate required for later source-independence, claim-verification, acquisition, and specialist-routing work.

The design is additive. It must not replace the current collector process, socket air gap, priority frontier, connector set, ranking stack, or local fallback synthesis.

## Evidence Basis

This design is based on direct source inspection, not repository descriptions.

### Existing application

A normal run enters `backend/research/research_pipeline.py::run_search`, calls `guard.prepare_topic`, creates queries with `planner.plan_queries`, retrieves through `explorer.explore`, ranks through `ranking.hybrid_ranker.rank_items`, synthesizes in `_synthesize`, and writes a Markdown archive through `synthesis.report_generator.write_report`.

`backend/research/explorer.py::_explore` creates `frontier.priority_frontier.ResearchFrontier`, sends search and fetch tasks through `_CollectorPool`, performs concurrent search and fetch batches with `ThreadPoolExecutor`, expands coverage gaps and OpenAlex citations, then returns `Evidence` objects.

`backend/retrieval/collector_client.py::CollectorClient` enforces outbound watchlist assertions, starts a child collector process, quarantines and redacts returned IPC data, and asserts the sanitized payload again. `collector_worker.py::run_ipc_loop` is the network-process boundary. `ResearchFrontier` owns resource limits and URL, DOI, content, domain, and in-flight coordination.

### Directly inspected reference implementations

- Hyperresearch: `src/hyperresearch/core/runs.py::{init_run,record_event,set_step,_save}` stores a manifest, appends events, tracks budget and step status, and atomically replaces the manifest. `core/independence.py::compute_independence` and `core/citecheck.py::{extract_pairs,triage_pairs}` separate independence and citation support from report generation.
- lukeswade/deep-research: `app/research/storage.py::{RunStore,atomic_write_text,append_event}` stores per-run metadata and JSONL events, tolerating a torn final event. `app/research/dedupe.py::rank_diverse` combines fingerprints and per-domain limits.
- DeerFlow: `backend/packages/harness/deerflow/agents/middlewares/durable_context_middleware.py` bounds and injects persisted goal, summary, delegation, and task-note data as untrusted context.
- Local Deep Research: `advanced_search_system/candidate_exploration/parallel_explorer.py::ParallelExplorer` separates concurrent breadth exploration from evidence evaluation.
- MiroFlow: `src/core/orchestrator.py::_handle_summary_with_context_limit_retry` records retries and reduces context after context-limit failures.
- Firecrawl Web Agent: `agent-core/src/orchestrator/compaction.ts::{compactMessages,createPrepareStepWithCompaction}` preserves a structured next step when context grows; `sub-agents.ts::createSubAgentTools` bounds agents by tool set and maximum steps.
- GPT Researcher: `gpt_researcher/actions/retriever.py::{get_retriever,get_retrievers,_load_plugin_retriever}` uses an adapter registry rather than embedding provider selection in orchestration.
- MiroThinker: `libs/miroflow-tools/.../task_planner.py::{load_todos,save_todos,add_todo,complete_todo}` persists explicit plan transitions in JSON.
- deep-searcher: `deepsearcher/agent/chain_of_rag.py::ChainOfRAG` applies bounded iterative follow-up with optional evidence-sufficiency stopping.
- Community-source techniques were inspected in lukeswade/deep-research `app/research/reddit.py::thread` and `youtube.py::transcript`, and last30days-skill `skills/last30days/scripts/lib/{reddit,github}.py`.
- The supplied `allenai/DR-Tulu` URL returned GitHub's repository-not-found response on 2026-09-28, so no code-level conclusion is drawn from it.

## Current Strengths That Must Remain

1. **Zero-secret-egress.** Watchlist terms, alias maps, and secret-bearing content remain outside all network workers and cloud calls. Persisted ledger fields must be sanitized before they are written.
2. **Process isolation.** Only the collector process may use public network connectors. The ledger runs in the secret core and never grants the collector access to persisted private state.
3. **Concurrent dual discovery.** The current connector fan-out and SearXNG fallback remain concurrent.
4. **Bounded traversal.** `ResearchFrontier` remains the authority for depth, time, byte, document, and domain limits.
5. **Current local-first behavior.** No API key remains a valid path; planning, ranking, verification, and local synthesis continue to function.
6. **Cancellation and report behavior.** Existing cancellation tokens, progress callbacks, `ResearchRun`, report archives, and CLI/server compatibility remain intact.

## Gap Matrix

| Capability | Current implementation | Reference implementation and symbols | Advantage | Difficulty / regression risk | Recommendation |
|---|---|---|---|---|---|
| Durable run state and resume | Final report archive only; `ResearchFrontier` is in-memory | Hyperresearch `runs.py`; lukeswade `RunStore` | Recovery after interruption and auditable trajectories | Medium / low if adapter is additive | Implement first |
| Recursive gap-driven research | `explorer._propose_gaps`, local `analyze_gaps`, citation expansion | deep-searcher `ChainOfRAG` iterative follow-up | Better explicit continuation decisions | Low / low | Keep; add ledgered rounds and measured gain |
| Decomposition | Query variants and optional model expansion; no persisted question plan | MiroThinker `task_planner.py`; deep-searcher `DeepSearch` | Explainable specialist work units | Medium / medium | Add after ledger as a planner adapter |
| Parallel specialists | Concurrent connector and fetch work only | Firecrawl `createSubAgentTools`; Local Deep Research `ParallelExplorer` | Independent perspectives where justified | High / medium | Defer; use bounded local lanes rather than free-form agents |
| Heterogeneous routing | Fixed `RetrievalRouter` worker list | GPT Researcher retriever registry | Easier optional providers | Medium / low | Add registry after persistence |
| Primary-source citation chasing | OpenAlex references and cited-by only | Hyperresearch scholar providers and cite-checking | Better authority and citation support | Medium / low | Extend in evidence-quality increment |
| Contradiction detection | `claim_verifier.verify_evidence` has lexical claim grouping | Hyperresearch citecheck plus independence | Less false corroboration | Medium / medium | Extend rather than replace |
| Duplicate-family analysis | URL, DOI, exact normalized-content dedupe | Hyperresearch `compute_independence`; lukeswade fingerprints | Avoid syndicated-source inflation | Medium / low | Add source-family records in evidence-quality increment |
| Browser difficult-page acquisition | One-shot Playwright fallback | Firecrawl tool workflow; lukeswade per-site fallbacks | Classify and retry failures | Medium / medium | Add a bounded acquisition-attempt ledger later |
| Persistent evidence memory | Evidence disappears except report | Hyperresearch vault; DeerFlow durable context | Resume and cross-run audit | Medium / low | Implement sanitized per-run evidence now |
| Evidence-quality scoring | Relevance/reranking only | Local Deep Research evaluator | Better selection and diagnostics | Medium / low | Follow ledger |
| Adversarial review | Tensions section receives local verifier output | Hyperresearch citecheck; Firecrawl specialist tools | Explicit counter-evidence checks | Medium / medium | Add after evidence bindings exist |
| Claim/citation verification | Local grouped lexical claims | Hyperresearch pair extraction and triage | Citable claim-support verdicts | Medium / low | Follow ledger |
| Community intelligence | Hacker News connector only | lukeswade Reddit/YouTube; last30days Reddit/GitHub | First-hand operational evidence | Medium / medium | Optional, source-labeled adapters later |
| Information-gain stopping | Hard time/document/byte/depth limits only | deep-searcher `ChainOfRAG.early_stopping` | Stops unproductive long runs | Low / low | Implement now with deterministic signals |

## Scope

### Included in this increment

- A local-only run manifest and append-only event ledger.
- Serializable frontier state and restored continuation.
- Sanitized evidence, query, search, fetch, and stop records.
- Explicit phase and terminal stop state.
- Deterministic, configurable diminishing-information-gain stopping.
- A resume entry point usable by the Python API, CLI, and HTTP layer.
- Tests for normal runs, cancellation, interruption/resume, provider failure, duplicate-heavy discovery, privacy-safe persistence, and low-gain stopping.
- Architecture map, gap matrix, and decision log documentation.

### Excluded from this increment

- Cloud-dependent autonomous specialist agents.
- New external persistence services, databases, vector stores, or credentials.
- Replacing the collector IPC protocol or the existing frontier.
- Reddit, YouTube, GitHub, or social providers.
- Browser interaction beyond recording existing acquisition outcomes.
- LLM-based stop judgments.

## Architecture

```text
run_search / resume_search
  │
  ├─ RunStore.create_or_load (secret core, sanitized local files)
  │     ├─ manifest.json          atomic snapshot
  │     └─ events.jsonl           append-only lifecycle records
  │
  ├─ planner.plan_queries
  │     └─ checkpoint: planned queries
  │
  ├─ explorer.explore
  │     ├─ ResearchFrontier export/import state
  │     ├─ collector IPC remains unchanged
  │     ├─ checkpoint: search/fetch outcome and accepted evidence
  │     └─ InformationGainTracker evaluates completed batch/round
  │
  ├─ rank + synthesis + report archive
  │     └─ checkpoint: completed or terminal stop reason
  │
  └─ ResearchRun exposes run_id, stop_reason, ledger path
```

### Run directory layout

```text
research_runs/
  <run-id>/
    manifest.json
    events.jsonl
    evidence.jsonl
```

`manifest.json` is a current, atomically replaced snapshot. It contains a schema version, run identity, sanitized topic representation, immutable sanitized options, phase, status, stop reason, budget counters, a frontier snapshot, and latest event sequence. It contains no raw watchlist values, alias maps, or unredacted network payloads.

`events.jsonl` is append-only. Each event includes a monotonically increasing sequence, UTC time, event kind, and sanitized payload. A malformed final line is ignored during recovery. `evidence.jsonl` stores accepted, sanitized evidence records in arrival order; it is an audit aid, not a replacement for current ranking.

### Run phases and terminal states

Phases: `created`, `planned`, `searching`, `fetching`, `expanding`, `ranking`, `synthesizing`, `reporting`, `completed`.

Terminal status is one of `success`, `cancelled`, `interrupted`, or `failed`. A terminal run also records exactly one stop reason: `completed`, `cancelled`, `time_budget`, `document_budget`, `byte_budget`, `depth_exhausted`, `low_information_gain`, `provider_failure`, or `internal_error`.

A phase transition and its matching event are written before entering an externally visible next stage. The resume path accepts `interrupted`, `cancelled`, and non-terminal runs. It rejects completed success runs unless an explicit future force-resume option is added.

### Frontier serialization

`ResearchFrontier` gains `export_state()` and `from_state()` methods. The snapshot contains only existing frontier primitives: queues, visited URLs/DOIs/content hashes, in-flight reservations normalized back to queued candidates, domain counts, budgets, and elapsed time. It never serializes a lock, a process handle, collector state, raw response body beyond already accepted sanitized evidence, or a watchlist.

On restore, in-flight entries are requeued exactly once with their original priority. This avoids work loss after a process interruption while retaining current URL/DOI deduplication.

### Information gain

`InformationGainTracker` measures an accepted batch against the prior accepted state. It records:

- accepted documents;
- new canonical domains;
- new DOI-bearing academic sources;
- new content hashes;
- new evidence-graph coverage-gap concepts resolved;
- new source families when family inference is later available.

The first increment uses the first four signals and existing evidence-graph concepts. A batch is low-gain when it accepts no new document and adds neither a new domain nor a newly resolved graph concept. Research stops only after `low_information_gain_rounds` consecutive low-gain rounds, only after the minimum document count, and never before a queued higher-priority citation candidate is processed. Defaults preserve present behavior: the feature is opt-in until tests prove no surprise early termination.

## Public Interfaces

```python
@dataclass(frozen=True)
class RunCheckpoint:
    run_id: str
    status: str
    phase: str
    stop_reason: str | None
    ledger_path: str

class RunStore:
    def create(self, run_id: str, topic: str, options: SearchOptions, watchlist: list[str]) -> RunCheckpoint: ...
    def load(self, run_id: str, watchlist: list[str]) -> dict: ...
    def checkpoint(self, phase: str, payload: dict, watchlist: list[str]) -> None: ...
    def append_evidence(self, evidence: Evidence, watchlist: list[str]) -> None: ...
    def finish(self, status: str, stop_reason: str, watchlist: list[str]) -> None: ...

class InformationGainTracker:
    def observe_batch(self, evidence: list[Evidence], frontier: ResearchFrontier) -> GainObservation: ...
    def should_stop(self, minimum_documents: int) -> bool: ...

def resume_search(run_id: str, watchlist: list[str], *, progress_callback=None, collector=None) -> ResearchRun: ...
```

The exact serialized format is internal and versioned. `run_to_dict` receives additive fields only. Existing callers that construct `SearchOptions` or consume `ResearchRun` retain their behavior.

## Privacy and Reliability Rules

1. Every string entering the ledger passes `redact` and `assert_safe_to_send`-equivalent local checks before write.
2. The collector never receives a run directory, manifest, prior raw evidence, or watchlist.
3. Ledger writes use temporary sibling files followed by replace. JSONL writes flush after each event.
4. Corrupt manifests fail closed with an actionable `RunStoreError`; a malformed trailing event is ignored.
5. Resume always reconstructs a fresh collector pool. Process handles and locks are never persisted.
6. Provider failures are events and do not terminate a run unless no usable provider path remains.
7. Cancellation checkpoints immediately after the current safe batch boundary and returns current evidence for existing partial-report behavior.

## Test Strategy

Tests remain offline and mock collector responses at the existing process boundary.

- **Persistence:** manifest atomic recovery, sequence ordering, sanitized fields, malformed final JSONL event, options round-trip.
- **Frontier:** snapshot/restore preserves queue priority, dedupe, domain budgets, and requeues stale in-flight candidates once.
- **Resume:** an interrupted two-batch run completes after restore without refetching accepted URLs.
- **Failure recovery:** a failed provider or fetch creates an event and continues with other evidence.
- **Information gain:** low-gain threshold does not trigger before minimum evidence, does trigger after consecutive no-novelty rounds, and does not preempt prioritized citation candidates.
- **Security:** watchlist text in topic, evidence, exception, and event payload is redacted before persistence; no ledger object is added to collector tasks.
- **Regression:** current search, cancellation, ranking, local synthesis, cloud-safe summary, connector concurrency, and report archive tests remain green.

## Documentation Deliverables

- This design specification.
- `docs/architecture/research-pipeline.md`: current and target architecture map.
- `docs/research-reference-gap-matrix.md`: expanded source-inspected comparison matrix.
- `docs/decision-log/2026-09-28-durable-research-ledger.md`: concise implementation decisions and rejected alternatives.
- User-facing CLI/API documentation for run IDs, run inspection, and resume.

## Decision Log

1. **Use filesystem JSON and JSONL, not SQLite.** The project currently has no database dependency. Atomic files keep the first increment local, inspectable, and easy to test. A future store adapter may add SQLite without changing orchestration.
2. **Persist sanitized evidence only.** This preserves zero-secret-egress and avoids creating a durable secret-bearing corpus.
3. **Persist at batch boundaries, not each network byte.** This bounds write overhead and aligns snapshots with the existing concurrent fetch architecture.
4. **Use deterministic information gain, not LLM self-evaluation.** It is reproducible, works offline, and cannot leak evidence externally.
5. **Do not introduce free-form subagents now.** They add model dependency, privacy surface, and difficult cancellation semantics before durable state exists.
6. **Do not replace `ResearchFrontier`.** Its existing resource limits, concurrency coordination, and dedupe logic are working behavior. Persistence wraps it through explicit state export/import.
7. **Keep report archives separate from the ledger.** Reports remain the user artifact; the ledger records execution provenance and recovery state.

## Acceptance Criteria

1. A simulated interruption after at least one accepted batch creates a resumeable run and restores it without repeating accepted fetches.
2. No watchlist term appears in any run manifest, event, or evidence ledger test fixture after persistence.
3. Existing offline suites remain green.
4. A duplicate-heavy run terminates with `low_information_gain` only when the configured threshold and minimum-evidence conditions are met.
5. Existing runs without the new feature flag behave as before.
6. The CLI and HTTP response expose run ID, current status, stop reason, and resume location without breaking old fields.
