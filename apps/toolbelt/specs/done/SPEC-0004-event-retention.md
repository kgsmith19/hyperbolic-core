---
title: core.event retention
spec_id: SPEC-0004-event-retention
slice: SL-004
status: done
created: 2026-08-08
updated: 2026-08-08
owner: Kyle
completed: 2026-08-08
traces: [FR-008]
---

# SPEC-0004: core.event retention

## 1. In one sentence

A daily scheduled job deletes every `core.event` row older than 90 days, adding 1 to a permanent monthly total for that row's month before it deletes it.

## 2. Why this, why now

| Field | Answer |
|---|---|
| Requirement being served | FR-008 |
| What a user can do after this that they could not before | Nothing user-facing changes; what changes is that `core.event` -- named in `docs/DATA-FLOW-DIAGRAM.md` as "the unbounded-growth table" and tracked as RISK-001 in `SPEC-0000` -- now has a real, running mitigation instead of an accepted-but-unbuilt risk |
| Why this slice comes before the next one | It is the last slice in the PRD's own slice plan (section 13); every other slice in `toolbelt` is shipped |
| What we learn from shipping it | Whether `pg_cron` is a durable enough scheduling mechanism for this project, and whether a monthly count is enough detail or a future tool wants a breakdown |

This slice proceeds ahead of `PRD ASM-002`'s literal precondition ("`core.event`'s retention policy can wait until a tool actually writes to it") -- confirmed live before writing this spec, `core.event` still holds 0 rows. The PRD's change log (v0.1.10) records why: the retention rule itself was already ratified (`DR-003`, `Q-002`), the mechanism is $0 marginal cost and fully reversible, and the monthly total's shape here is the minimal reading of "aggregate" that ratification supports.

## 3. Scope

### 3.1 In scope

- One new table, `core.event_monthly_agg(month date primary key, event_count bigint not null default 0)`
- One Postgres function, `core.purge_old_events() returns bigint`: for every `core.event` row with `at` older than 90 days, adds 1 to its calendar month's total (creating that month's row if absent), deletes the row, and returns the count of rows deleted
- `grant execute` to `authenticated` -- the same shape as `core.log_run` (SPEC-0003), callable directly, not only by the schedule
- Enabling the `pg_cron` extension (already present on the project per `list_extensions`, not yet enabled -- a first-party Postgres/Supabase extension, not a new third-party service under halt H7)
- A daily `pg_cron` schedule calling the function

### 3.2 Out of scope

| Not doing | Why not | Where it goes instead |
|---|---|---|
| A breakdown of the monthly total by `app_id`, `kind`, or any other dimension | `DR-003`/`Q-002` name only "a monthly aggregate," not a dimension; inventing one here is a product decision this spec does not have standing to make | A future slice, if a real question ever needs the breakdown |
| A configurable retention window | `Q-002` already ratified 90 days as a fixed number; a config table/column for a number nobody has asked to vary is speculative generality | A future slice, if the number itself needs to change |
| Fixing the dormant self-referential `parent_id` FK ordering edge case (a to-be-purged child event whose parent event is not yet 90 days old) | No `core.event` row has ever used `parent_id`; nothing writes step-level/nested events yet (`SPEC-0003` section 3.2 deferred this same table). Building for a shape with zero real instances is exactly what "no speculative generality" rules out. | Named as RISK-010 below; revisit if a tool starts writing nested events |
| A UI surface showing the monthly totals | Nothing in the PRD asks anything to read `core.event_monthly_agg` yet | A future slice, when something needs to display it |
| Any change to `core.event`'s own schema, RLS, or grants | Out of scope; this slice is purely a downstream consumer of the existing table | Unchanged |

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-016 | `core.event` has a row with `at` 100 days in the past (calendar month `2026-05`) and a row with `at` 1 day in the past | `core.purge_old_events()` is called | The 100-day-old row no longer exists in `core.event`; the 1-day-old row still exists; `core.event_monthly_agg` has a row for `2026-05-01` with `event_count` at least 1 higher than before the call | FR-008 |
| AC-017 | `core.event_monthly_agg` already has a row for month `2026-05-01` with `event_count = N` (from a prior call), and `core.event` gains one new row 100 days old in that same month | `core.purge_old_events()` is called again | The row for `2026-05-01` now has `event_count = N + 1` (added to, never replaced or reset) | FR-008 |

AC-017 is what makes accumulate-not-replace a tested guarantee, not just a comment in the SQL.

## 5. Properties

| ID | Property | Kind | Input domain | Traces to |
|---|---|---|---|---|
| PROP-037 | Every call ends in one of two states: success (a count returned; every row it examined either deleted-and-counted or left alone) or an unhandled Postgres error surfaced to the caller -- never a partial write where rows are deleted without their month's count recorded, or counted without being deleted. The one dormant exception: a to-be-purged child event whose `parent_id` points at a not-yet-90-day parent fails the whole call atomically (RISK-010) -- named, not solved, since no real row has ever exercised it. | Error totality | Every call, against fixture data with and without qualifying rows | FR-008 |
| PROP-038 | Round-trip: the count `purge_old_events()` returns equals the number of rows actually removed from `core.event` by that call, verified by reading `core.event`'s row count immediately before and after the same call. | Round-trip | AC-016's call | FR-008 |
| PROP-039 | Invariant: every increment `core.event_monthly_agg` ever receives is backed by a `core.event` row that genuinely existed and was over 90 days old at the moment of that same call -- never a total incremented for a row that was not actually deleted in that call. | Invariant | All rows the function touches | FR-008 |
| PROP-040 | Idempotence: calling `purge_old_events()` a second time immediately after the first, with no new qualifying rows in between, is a true no-op -- it deletes nothing further and adds 0 to every monthly total. Unlike `core.log_run` (`SPEC-0003` PROP-031, deliberately not idempotent), this function purges a set defined by a condition (age), not a distinct event per call, so idempotence is the correct and tested shape here. | Idempotence | Two consecutive calls, no new data between them | FR-008 |
| PROP-041 | Order independence: two qualifying rows in different months are purged to the same final state regardless of which one Postgres's query planner processes first -- the monthly total is keyed by calendar month, not by row-processing order. | Order independence | Multi-month fixture data | FR-008 |
| PROP-042 | Oracle / model: FR-008's own acceptance criterion (AC-016's exact existence and count assertions) is the oracle; AC-016 and AC-017 assert against it directly. | Oracle / model | FR-008's stated ACs | FR-008 |
| PROP-043 | Metamorphic: purging a set of N qualifying rows in one call must leave `core.event_monthly_agg` at the same final counts as purging two disjoint halves of that same set across two separate calls -- AC-017's accumulate-not-replace behavior is exactly what makes the split-run case equal the single-run case. | Metamorphic | Split vs. whole runs over the same fixture data | FR-008 |
| PROP-044 | Conservation: any row that ever existed in `core.event` is accounted for in exactly one place at any moment -- either still present in `core.event`, or purged and counted in exactly one `core.event_monthly_agg.event_count` (its own month's total) -- never both, never neither. This is the conservation law AC-016 and AC-017 together verify: a row disappears from one table exactly as its month's count rises by exactly the number of rows purged from that month. | Conservation | All rows the function ever touches | FR-008 |
| PROP-045 | Monotonicity: `core.event_monthly_agg.event_count` for a given month never decreases across calls -- it holds steady when no new rows in that month qualify, and only ever increases otherwise (AC-017). | Monotonicity | Repeated calls over time | FR-008 |

## 6. Budget declaration

| Metric | Declared | Ceiling | Status |
|---|---|---|---|
| Net source LOC | ~40 (migration ~35, down ~5) | 300 | within |
| Test LOC | ~70 (`tests/retention.test.mjs`) | 200 | within |
| New modules | 0 | 2 | within |
| Source files touched | 2 (migration, down migration) | 3 | within |
| Test files touched | 1 (new) | 3 | within |
| New tables | 1 (`core.event_monthly_agg`) | 1 | within, at ceiling |
| New columns | 2 (`month`, `event_count`) | 6 | within |
| New endpoints | 1 (`rpc/purge_old_events`, PostgREST auto-exposed) | 1 | within, at ceiling |
| New tests | 2 | 8 | within |

## 7. Changes

### 7.1 Interfaces

One new PostgREST-exposed RPC endpoint, `POST /rest/v1/rpc/purge_old_events`, auto-generated the same way every function-backed endpoint in this project already is. Internally, one `pg_cron` schedule entry calls the same function on a timer; this is not a REST interface and has no caller-facing shape.

### 7.2 Data

| Change | Table(s)/objects | Forward migration | Down migration | Backfill needed | Zero-downtime approach |
|---|---|---|---|---|---|
| Add `core.event_monthly_agg` table, `core.purge_old_events` function, `pg_cron` extension + schedule | `core.event` (read and deleted from; not schema-changed), `core.event_monthly_agg` (new) | `supabase/migrations/20260808120000_core_event_retention.sql` | `supabase/migrations/20260808120000_core_event_retention_down.sql` | no | Adds a table, a function, and a schedule only; no existing row or caller is touched. `core.event` currently holds 0 rows, so the first real run has nothing to purge. |

### 7.3 Files expected to change

| Path | Action | Why |
|---|---|---|
| `supabase/migrations/20260808120000_core_event_retention.sql` / `_down.sql` | create | AC-016, AC-017 |
| `tests/retention.test.mjs` | create | AC-016, AC-017 |

## 8. Test plan

| Test ID | Level | Traces to | Failure mode it catches | Why not a cheaper level | Why not covered already | Deletion criterion |
|---|---|---|---|---|---|---|
| T-A-007 | acceptance | AC-016 -> FR-008 | The job deletes a row that is not yet 90 days old, keeps one that is, or deletes a row without first recording its month in the monthly total | End-to-end through the real function is the AC as written; deleting live event history on a boundary error is real, irreversible data loss | No other test calls `core.purge_old_events` | If `core.event` retention is replaced by a different mechanism (e.g. native Postgres partitioning) |
| T-I-010 | integration | AC-017 -> FR-008 | Running the job on two separate occasions for the same calendar month overwrites the monthly total instead of adding to it, undercounting real history | The accumulate-not-replace behavior lives in one `on conflict do update` clause; nothing cheaper than actually running the function twice proves it does not regress to an overwrite or a no-op | T-A-007 only calls the function once; this is the distinct multi-call claim | Never; this is the durability guarantee DR-003 makes ("kept forever") |

## 9. Risks

| ID | Risk | Likelihood | Impact | Mitigation | Accepted by |
|---|---|---|---|---|---|
| RISK-010 | A to-be-purged child `core.event` row (via the self-referential `parent_id` FK) whose parent row is not yet 90 days old would fail the whole call atomically, purging nothing that cycle. | very low (nothing writes `parent_id` today; a parent and its children are created within one run's execution window, not 90 days apart) | low today; would delay purging, not corrupt or lose data (the call rolls back cleanly) | Named explicitly here rather than silently assumed away; revisit if a tool starts writing nested/step-level events (`SPEC-0003` section 3.2 deferred that same feature) | Kyle |
| RISK-011 | `pg_cron` jobs run as the role that called `cron.schedule` (the migration-applying role); if that role's privileges ever change, or `pg_cron` is ever disabled, the schedule stops firing with no application-level alert. | low | low today (single project, single user, `core.event` still empty) | `core.purge_old_events()` stays directly callable via RPC by any authenticated caller, the same backstop `core.log_run` established -- a human can always run it manually | Kyle |
| RISK-012 | `security definer` functions are a known Postgres footgun if `search_path` is not pinned (search-path hijacking), the same class of risk `SPEC-0003` named for `core.log_run` (RISK-009). | low (this function schema-qualifies every reference) | high if ever gotten wrong | `set search_path = core, pg_temp` pinned explicitly, same as `core.log_run` | Kyle |

## 10. Rollback plan

| Field | Answer |
|---|---|
| How to undo | Run the down migration: unschedule the `pg_cron` job, `DROP FUNCTION core.purge_old_events`, `DROP TABLE core.event_monthly_agg` |
| Time to undo | Under 5 minutes; three drop/unschedule statements |
| Data written that survives rollback | None, and this is a real, one-way consequence worth stating plainly: any `core.event` rows already purged by the time of rollback are not recoverable from `core.event` itself -- only their month's count survived in `core.event_monthly_agg`, and the down migration drops that table too. Not a concern today (`core.event` holds 0 rows and the job has never run for real), but it would matter after the job has been live for a while. |
| Feature flag | None; a caller invoking a dropped RPC gets a `404`, the same failure shape as any nonexistent endpoint. An unscheduled `pg_cron` job simply stops firing. |
| Who decides to roll back | Kyle |
| Signal that triggers rollback | AC-016 or AC-017 fails after deploy, or the "data written that survives rollback" cost above becomes unacceptable once the job has run for real |

## 11. Assumptions made during implementation

| ID | Assumption | Why |
|---|---|---|
| ASM-022 | The schedule fires daily at 03:00 UTC. | Nothing in the PRD names an exact cadence. Daily is the smallest interval that reliably keeps `core.event` under roughly 91 days old without scheduling a job that, most days, purges nothing at all. |
| ASM-023 | `core.purge_old_events()` is `security definer`, matching `core.log_run`'s precedent, even though `core.event`'s existing blanket `authenticated` grant (`SPEC-0003` RISK-008) already permits a direct delete today. | Not required for this slice to function, but it keeps the function working unchanged if `core.*`'s grants are ever tightened later, the same forward-looking reasoning `SPEC-0003` ASM-019 used for `log_run`. |
| ASM-024 | The monthly bucket is the first-of-month `date` derived from `at` via `date_trunc('month', at)`, evaluated in the database session's timezone (UTC, Supabase's default) -- not any caller's local timezone. | No requirement names a specific timezone for bucketing, and UTC is what every other `timestamptz` column in this schema already resolves against; introducing a different rule for this one column would be inconsistent for no stated reason. |

## 12. Definition of Done

- [x] T-A-007, T-I-010 green; red recorded first (`PGRST202`, function not found in the schema cache) before the migration existed.
- [x] Ledger rows predate the tests; mutation-verified 2026-08-08. T-A-007: replaced the delete's `where` clause with `where false`, leaving the aggregate insert intact; red (old row still existed), reverted. T-I-010: changed the accumulate `on conflict do update` to a plain overwrite; red on both tests (T-I-010's own claim, and T-A-007 independently via its own accumulated live-database history dropping below its `countBefore` floor), reverted -- two distinct mutations, each isolating one test's own claim.
- [x] Existing suite still passes unmodified: 15/15 green (13 pre-existing + 2 new), ~2.5s.
- [x] PRD FR-008 -> `done`; SL-004 marked shipped (v0.1.11); change-log entry.
- [x] `docs/SYSTEM-REQUIREMENTS.md` (SR-004, SR-007 table counts; SR-029, SR-030, SR-031) and `docs/DATA-FLOW-DIAGRAM.md` (F-10, trust-boundary table counts, `core.event`/`core.event_monthly_agg` data-at-rest rows) updated.
- [x] Spec moved to `done/`, dates set.
