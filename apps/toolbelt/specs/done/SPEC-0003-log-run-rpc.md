---
title: core.log_run RPC
spec_id: SPEC-0003-log-run-rpc
slice: SL-003
status: done
created: 2026-08-07
updated: 2026-08-07
owner: Kyle
completed: 2026-08-07
traces: [FR-007]
---

# SPEC-0003: core.log_run RPC

## 1. In one sentence

Any authenticated tool records a run by calling `core.log_run`, a Postgres function that writes one `core.run` row and one `core.cost` row, instead of any tool ever writing directly into `core.*`.

## 2. Why this, why now

| Field | Answer |
|---|---|
| Requirement being served | FR-007 |
| What a user can do after this that they could not before | A tool can log a real run without its own repo owning any knowledge of `core.run`/`core.cost`'s column shape |
| Why this slice comes before the next one | `prompt-organizer`'s own PRD names `NFR-010` ("every render must write one `core.run` row and one `core.cost` row"), currently `blocked` because its `CLAUDE.md` forbids writing to any schema but `prompt`. This RPC is what unblocks it. Kyle asked directly for the mechanism decision (2026-08-07); this spec is that decision. |
| What we learn from shipping it | Whether an RPC is a durable enough contract for cross-repo instrumentation, or whether a second calling tool exposes a shape this one function cannot cover |

## 3. Scope

### 3.1 In scope

- One Postgres function, `core.log_run(p_app_id text, p_kind text, p_wall_clock_ms bigint, p_ref text default null) returns uuid`: inserts one `core.run` row (`status = 'ok'`, `ended_at = now()` — the caller only logs a run that already finished) and one `core.cost` row referencing it, returns the run's `id`
- `grant execute` to `authenticated` only
- `prompt-organizer` calling this RPC from its copy handler (a second, small commit in that repo, not this spec's own files, tracked as a follow-up there)

### 3.2 Out of scope

| Not doing | Why not | Where it goes instead |
|---|---|---|
| `core.event` rows | No AC demands step-level event logging yet; `core.run`/`core.cost` is what `prompt-organizer`'s `NFR-010` actually asks for | A future slice, when a tool needs multi-step event logging within one run |
| Token/LLM-call/intervention fields on `core.cost` (`input_tokens`, `llm_calls`, `usd`, ...) | No current caller (a template-substitution render) produces any of these; they stay at the column's own `0` default | A future slice, when a real LLM-calling tool needs to report them — the function signature grows then, not speculatively now |
| Tightening `core.*`'s existing blanket `authenticated` grants to force every write through this RPC | A real, separate security-hardening change affecting every current and future table in `core`, already recorded as an accepted risk (`SPEC-0000` RISK-002); revoking it is a bigger, riskier slice than "add one RPC" | A dedicated security-hardening slice, if Kyle wants the boundary enforced rather than conventional |
| `core.outcome`/`core.run_outcome` writes | Not named by `FR-007` or `NFR-010`; UC-002's step 3 already covers tools writing these directly, unchanged | Unchanged; this RPC only replaces the `core.run`/`core.cost` half of UC-002's step 2 |

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-014 | `core.app` has a row with `id=prompt-organizer` | An authenticated caller calls `POST /rest/v1/rpc/log_run` with `p_app_id=prompt-organizer, p_kind=render, p_wall_clock_ms=42` | The call succeeds; a `core.run` row exists with `app_id=prompt-organizer, kind=render, status=ok`, `ended_at` set; a `core.cost` row exists referencing that run's `id` with `wall_clock_ms=42` | FR-007 |
| AC-015 | `core.app` has no row with `id=nonexistent-tool` | An authenticated caller calls `POST /rest/v1/rpc/log_run` with `p_app_id=nonexistent-tool, p_kind=render, p_wall_clock_ms=1` | The call fails with Postgres error code `23503` (foreign key violation); no `core.run` or `core.cost` row is created | FR-007 |

AC-015 is the failure case.

## 5. Properties

| ID | Property | Kind | Input domain | Traces to |
|---|---|---|---|---|
| PROP-028 | Every `log_run` call ends in success (a real `run_id` returned, exactly one `core.run` and one `core.cost` row created) or a named Postgres error (`23503` bad `app_id`); never a partial write (a `core.run` row with no matching `core.cost` row, or vice versa). | Error totality | Every `p_app_id` valid and invalid; `p_wall_clock_ms` zero, typical, and large | FR-007 |
| PROP-029 | Round-trip: the `run_id` the RPC returns is exactly the `id` of the `core.run` row it created, readable by the same caller immediately after. | Round-trip | AC-014's call | FR-007 |
| PROP-030 | Invariant: every `core.cost` row this RPC creates references a `core.run` row that exists and was created in the same call — never an orphan. | Invariant | All RPC-created rows | FR-007 |
| PROP-031 | Idempotence: none applies, by design. Each call logs a distinct event; calling twice with identical arguments legitimately creates two `core.run` rows, not one — `core.run.id` has no natural key across calls. | Idempotence | n/a | — |
| PROP-032 | Order independence: none applies. Two `log_run` calls do not interact. | Order independence | n/a | — |
| PROP-033 | Oracle / model: FR-007's own acceptance criterion (the exact row shapes AC-014 names) is the oracle; AC-014 asserts against it directly. | Oracle / model | FR-007's stated AC | FR-007 |
| PROP-034 | Metamorphic: none applies. No numeric input this function transforms; `p_wall_clock_ms` is stored verbatim. | Metamorphic | n/a | — |
| PROP-035 | Conservation: none demanded. `count(core.app)` is unchanged by any `log_run` call; not separately tested, same reasoning as `SPEC-0000` PROP-007. | Conservation | n/a | — |
| PROP-036 | Monotonicity: none applies. This function performs no aggregation, ranking, or scoring. | Monotonicity | n/a | — |

## 6. Budget declaration

| Metric | Declared | Ceiling | Status |
|---|---|---|---|
| Net source LOC | ~25 (migration ~20, down ~3) | 300 | within |
| Test LOC | ~45 (`tests/log_run.test.mjs`) | 200 | within |
| New modules | 0 | 2 | within |
| Source files touched | 2 (migration, down migration) | 3 | within |
| Test files touched | 1 (new) | 3 | within |
| New tables | 0 | 1 | within |
| New columns | 0 | 6 | within |
| New endpoints | 1 (`rpc/log_run`, PostgREST auto-exposed from the function, same mechanism every table endpoint already uses) | 1 | within, at ceiling |
| New tests | 2 | 8 | within |

## 7. Changes

### 7.1 Interfaces

One new PostgREST-exposed RPC endpoint, `POST /rest/v1/rpc/log_run`, auto-generated from the function the same way every table's REST endpoint already is — no custom server code.

### 7.2 Data

| Change | Table(s)/objects | Forward migration | Down migration | Backfill needed | Zero-downtime approach |
|---|---|---|---|---|---|
| Add `core.log_run` function + grant | `core.run`, `core.cost` (written by the function; no schema change to either) | `supabase/migrations/20260807080000_core_log_run_rpc.sql` | `supabase/migrations/20260807080000_core_log_run_rpc_down.sql` | no | Adds a function only; no existing table, row, or caller is touched |

### 7.3 Files expected to change

| Path | Action | Why |
|---|---|---|
| `supabase/migrations/20260807080000_core_log_run_rpc.sql` / `_down.sql` | create | AC-014, AC-015 |
| `tests/log_run.test.mjs` | create | AC-014, AC-015 |

## 8. Test plan

| Test ID | Level | Traces to | Failure mode it catches | Why not a cheaper level | Why not covered already | Deletion criterion |
|---|---|---|---|---|---|---|
| T-A-006 | acceptance | AC-014 -> FR-007 | The RPC creates the wrong rows, wrong values, or fails to link `core.cost` to the `core.run` it just created | End-to-end through the real RPC is the AC as written | No other test calls this RPC | If `log_run` is replaced by a different mechanism |
| T-I-009 | integration | AC-015 -> FR-007 | A call naming an unregistered tool succeeds anyway | The FK is the mechanism; this proves the RPC does not swallow or mask it | No other test calls this RPC with a bad `app_id` | Never; this is the same integrity guarantee T-I-003 proved for direct inserts |

## 9. Risks

| ID | Risk | Likelihood | Impact | Mitigation | Accepted by |
|---|---|---|---|---|---|
| RISK-008 | `core.*`'s existing blanket `authenticated` grants mean this RPC is a convention, not a hard technical boundary — any caller could still bypass it with a direct insert. | certain (already true before this slice) | low today (single user, single real caller) | Named explicitly in section 3.2 rather than silently assumed away; `SPEC-0000` RISK-002 already accepted the same underlying grant shape | Kyle |
| RISK-009 | `security definer` functions are a known Postgres footgun if `search_path` is not pinned (search-path hijacking). | low (this function schema-qualifies every reference) | high if ever gotten wrong | `set search_path = core, pg_temp` pinned explicitly in the function definition | Kyle |

## 10. Rollback plan

| Field | Answer |
|---|---|
| How to undo | Run the down migration; `DROP FUNCTION core.log_run` |
| Time to undo | Under 5 minutes; one `DROP FUNCTION` |
| Data written that survives rollback | Any real `core.run`/`core.cost` rows already logged stay — they are legitimate history, not scaffolding this function's existence depends on |
| Feature flag | None; a tool that calls a dropped RPC simply gets a `404`, the same failure shape as calling any nonexistent endpoint |
| Who decides to roll back | Kyle |
| Signal that triggers rollback | AC-014 or AC-015 fails after deploy |

## 11. Assumptions made during implementation

| ID | Assumption | Why |
|---|---|---|
| ASM-019 | `core.log_run` is `security definer` even though `core.*`'s existing blanket grants would let it work as `security invoker` too | Not required for this slice to function, but it is what makes a *future* tightening of `core.*`'s grants (RISK-008) possible without breaking this RPC — the function keeps working as its owner regardless of what the calling role's own grants are. `set search_path = core, pg_temp` is pinned per Postgres's own documented guidance for `security definer` functions, mitigating RISK-009. |
| ASM-020 | The function sets `status = 'ok'` and `ended_at = now()` at insert time, never leaving a row at the `running`/`null` default | A tool calls this RPC to log a render that has *already finished* (matching `prompt-organizer`'s actual call site: after the clipboard write, not before it) — leaving `status` at its `running` default would misrepresent completed work as still in progress, with nothing to ever transition it. |
| ASM-021 | `p_ref` defaults to `null` and no caller currently supplies it | `NFR-010`/`FR-007` name only `app_id`, `kind`, and wall-clock time; nothing demands a reference string yet. The parameter exists because `core.run.ref` already does (unused elsewhere is not the same as unneeded here), and a future caller can supply it without a signature change. |

## 12. Definition of Done

- [x] T-A-006, T-I-009 green; red recorded first (`PGRST202`, function not found in the schema cache — a real 404, not a collection/import error) before the migration existed.
- [x] Ledger rows predate the tests; mutation-verified 2026-08-07. T-A-006: hardcoded `wall_clock_ms` to `0` in the function body, red (`[{wall_clock_ms:0}]` vs expected `42`), reverted. T-I-009: wrapped the `core.run` insert in an exception handler swallowing `foreign_key_violation` and returning `null`, red (`200`/`null` instead of `409`/`23503`), reverted — deliberately a different mutation than re-dropping the FK constraint, since T-I-003 already proved that mechanism; this test's own distinct claim is that the RPC's code doesn't mask it.
- [x] Existing suite still passes unmodified: 13/13 green, 2.0s.
- [x] PRD FR-007 → `done`; SL-003 marked shipped (v0.1.9); change-log entry.
- [x] `docs/SYSTEM-REQUIREMENTS.md` (new section 2a, SR-028) and `docs/DATA-FLOW-DIAGRAM.md` (F-5 rewritten from a direct insert to the RPC call) updated.
- [x] Spec moved to `done/`, dates set.
