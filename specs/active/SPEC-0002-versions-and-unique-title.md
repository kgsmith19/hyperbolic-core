---
title: Versions on every body change, and unique titles
spec_id: SPEC-0002-versions-and-unique-title
slice: SL-004
status: active
created: 2026-08-07
updated: 2026-08-07
completed:
owner: Kyle
traces: [FR-002, FR-003, NFR-003, NFR-005]
---

# SPEC-0002: Versions on every body change, and unique titles

## 1. In one sentence

Every save of a prompt body writes an immutable version row, and two prompts can never share a title, case-insensitively.

## 2. Why this, why now

FR-003 and FR-002 — the PRD assigns both to SL-004. Versioning must exist before configurations (SL-005) and restore (SL-008) can; unique titles must exist before titles become lookup keys (FR-013). Runs in parallel with SL-001: their file lists are disjoint and only this slice owns a schema change (`rules/07-SKILLS.md` Level-1 rules).

## 3. Scope

**In:** table `prompt.prompt_version`; a trigger that records a version on every insert and body-update of `prompt.prompt`; a case-insensitive unique index on title (with a one-time dedup of accumulated test-fixture rows); an `UPDATE` grant on `prompt.prompt` (the edit path FR-003 requires); version immutability (NFR-005); the declared amendment to two SL-000 tests whose fixed-title re-runs the unique index would break (details in section 7.3 — a test change is never silent, so it is specified here).

**Out (S4):** any page/UI change — editing and version-browsing UI belong to SL-008 with FR-009 (`web/index.html` is SL-001's file this round; keeping it out preserves worktree disjointness); version diffing (PRD OOS-008); a `current_version` column — the current version is `max(version_no)`, a query, which is cheaper than a column to keep consistent; restore (FR-009, SL-008).

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-001 | A prompt titled `Spec Author` exists | `POST /rest/v1/prompt` with title `spec author` | `409` with Postgres code `23505`, and the response's detail names the conflicting value; no row created | FR-002 |
| AC-002 | A freshly inserted prompt | `GET` its `prompt_version` rows | Exactly one row: `version_no` 1, `body` equal to the inserted body | FR-003 |
| AC-003 | A prompt at version 1 with body `original body` | `PATCH` its body to `edited body` | `prompt_version` has version 1 = `original body` (unchanged) and version 2 = `edited body`; `max(version_no)` = 2 | FR-003 |
| AC-004 | Any `prompt_version` row | `PATCH` it; separately `DELETE` it | Each request is rejected — `42501` (no grant) — and the row is unchanged | NFR-005 |
| AC-005 | Up migration applied, suite green | The down migration runs | Table, trigger, function, and unique index are gone; the `UPDATE` grant on `prompt.prompt` is revoked; re-applying the up returns the suite to green. The one-time dedup is not reversed (it deletes only redundant test-fixture rows, recorded below) | CON-003 |

AC-001 and AC-004 are the failure cases.

## 5. Properties (all nine walked)

| ID | Property | Kind | Domain | Traces |
|---|---|---|---|---|
| PROP-001 | Every write to `prompt.prompt` ends in a named outcome: `201`, `200/204` (update), `409` (23505), `400` (23514), or `42501`; never a partial state — a prompt whose latest version body differs from its own body cannot exist after any sequence. | Error totality / invariant | Insert, duplicate insert, update, out-of-bounds update | FR-002, FR-003 |
| PROP-002 | Version history is append-only: an existing `(prompt_id, version_no, body)` triple is never altered by any later operation. | Invariant | Any update sequence | NFR-005 |
| PROP-003 | Monotonicity: `version_no` increases by exactly 1 per body change, no gaps, no reuse. Single-writer assumption recorded (CON-002: sole user; the trigger computes `max+1` without a concurrency guard, and adding one is speculative until a second concurrent writer exists). | Monotonicity | n consecutive updates | FR-003 |
| PROP-004 | Conservation: `count(prompt_version)` for a prompt equals 1 + its completed body-updates. | Conservation | Same | FR-003 |
| Others | Round-trip (body verbatim — already owned by SL-000's T-A-001, not duplicated); idempotence n/a (each update is a distinct version by design); order independence n/a (single writer, recorded above); oracle, metamorphic n/a. | — | — | — |

## 6. Budget declaration (standard ceilings)

| Metric | Declared | Ceiling | Status | Actual |
|---|---|---|---|---|
| Net source LOC | ~55 (up ~40, down ~12) | 300 | within | 82 raw / 51 executable (up 72/46, down 10/5; comments are spec-demanded reasoning) |
| Test LOC | ~110 (new file + the declared skeleton amendment) | 200 | within | 154 net (`versions.test.mjs` 131 new; skeleton +27/−4) |
| New modules | 0 | 2 | within | 0 |
| Source files touched | 2 (migration up, migration down) | 3 | within | 2 |
| Test files touched | 2 (`tests/versions.test.mjs` new; `tests/skeleton.test.mjs` amended, declared) | 3 | within | 2 |
| New tables | 1 (`prompt.prompt_version`) | 1 | within | 1 |
| New columns | 5 (`prompt_id`, `version_no`, `body`, `user_id`, `created_at`; PK is composite — no id column) | 6 | within | 5 |
| New endpoints / UI / libraries / third-party | 0 | — | within | 0 |
| User stories | 1 (U-001, UC-004) | 1 | within | 1 |
| New tests | 4 | 8 | within | 4 (function LOC 20 ≤ 40; complexity 3 ≤ 8; largest file 143 ≤ 250) |

## 7. Changes

### 7.1 Interfaces

None custom; PostgREST gains `/rest/v1/prompt_version` (read) automatically, and `PATCH /rest/v1/prompt` starts working (the grant exists now).

### 7.2 Data — one migration pair, applied ONLY by the integrator

`supabase/migrations/20260807040000_prompt_versions_and_unique_title.sql` (+ `_down.sql`):

1. **Dedup (one-time, destructive to fixtures only):** delete all but the earliest row per `lower(title)` in `prompt.prompt`. Accumulated duplicate-title rows are SL-000 test fixtures (its RISK-002); real data has one user and no duplicates worth keeping. Wrap in `alter table … no force row level security; … force row level security;` — forced RLS blocks even the owner, which SL-000's mutation drill proved.
2. `create unique index prompt_title_unique on prompt.prompt (lower(title));`
3. `grant update (title, body) on prompt.prompt to authenticated;` (the existing `owner_all` policy already scopes updates to the owner).
4. Table `prompt.prompt_version` (columns above; `primary key (prompt_id, version_no)`; `prompt_id references prompt.prompt(id) on delete cascade`); `grant select, insert on prompt.prompt_version to authenticated;` RLS enabled **and forced**; policies: select `using (user_id = auth.uid())`, insert `with check (user_id = auth.uid())`. **No update or delete grant and no update or delete policy exist — that pair of absences is NFR-005's mechanism.**
5. Trigger function `prompt.record_version()` (invoker rights — inserts carry `auth.uid()` through the insert policy) + `after insert or update of body on prompt.prompt for each row` trigger: inserts `(new.id, coalesce(max+1,1), new.body, new.user_id, now())`; the update branch fires only when `new.body is distinct from old.body`.

Down: drop trigger, function, table, index; revoke the update grant. Rehearsal on `lifeos-test` (DDL; steps 2–5 minus dedup), then the real project — **integrator only, serialized after SL-001's merge**.

### 7.3 Files expected to change

| Path | Action | Why |
|---|---|---|
| `supabase/migrations/20260807040000_prompt_versions_and_unique_title.sql` | create | AC-001..AC-004 |
| `supabase/migrations/20260807040000_prompt_versions_and_unique_title_down.sql` | create | AC-005 |
| `tests/versions.test.mjs` | create | AC-001..AC-004 |
| `tests/skeleton.test.mjs` | edit — **declared test change, per the never-silent rule** | T-A-001 and T-I-003 re-insert fixed titles (`Spec Author`, `rls probe`) every run; under the unique index the second run collides. Amended flow, same contracts: `POST`; on `409`, `PATCH` the body by title instead. T-A-001's round-trip read-back stays byte-identical (its AC unchanged) and now also exercises the FR-003 update path on re-runs; T-I-003's isolation assertions are unchanged. The tests were correct for SL-000's world; the world legitimately changed — recorded here, not silently. |

## 8. Test plan

| Test ID | Level | Traces | Failure mode | Why not cheaper | Why not duplicate | Deletion criterion |
|---|---|---|---|---|---|---|
| T-I-004 | integration | AC-001, PROP-001 | Two prompts share a title (case-folded), so title-as-key (FR-013) becomes ambiguous | The unique index is the mechanism; this proves it is wired through the real API | Only duplicate-title test | FR-002 changes |
| T-I-005 | integration | AC-002, PROP-004 | An insert records no version, so history starts at the first edit and the original is unrecoverable | Trigger behavior needs the real database | Only insert-version test | FR-003 changes |
| T-A-003 | acceptance | AC-003, PROP-002, PROP-003 | An edit overwrites history (version 1 lost or altered) — UC-004's exact loss | End-to-end through the API is the AC as written | Only update-version test | FR-003 changes |
| T-I-006 | integration | AC-004, PROP-002 | A stored version is changed or deleted after the fact | Grant/policy absence is the mechanism; this proves both probes are rejected | Only immutability test | NFR-005 changes |

Plus the amended skeleton tests staying green (their own ledger rows carry an amendment note; no new IDs).

**Red first** (before the migration exists, run by the worker): T-I-004 red — duplicate insert returns `201` not `409`; T-I-005/T-A-003/T-I-006 red — `prompt_version` requests return `404` (`PGRST205`, table absent) against expected `200`/`42501`; the `PATCH` in T-A-003 returns `42501` (no grant yet). Every failure is a status/code assertion, not an import error (R2). Ledger rows before tests.

**Worker/DB division (binding):** the worktree agent writes files and runs red; it must not apply migrations or otherwise alter the shared database's schema (test-row inserts via the API are fine — dedup cleans them). The integrator rehearses and applies the migration in slice order, after which the worker's continuation runs green. Mutation drills that need DDL (drop the index, drop the trigger, add a hostile grant) are run by the integrator with the worker's tests as the probes, recorded in the ledger.

## 9. Risks

RISK-001: `max+1` versioning has a race under concurrent writers — accepted and recorded in PROP-003; CON-002 (sole user) is the guard, and a `select … for update` or sequence-per-prompt is the known fix when that assumption breaks. RISK-002: the dedup deletes fixture rows sharing a title — irreversible by design; only fixture data exists (recorded in AC-005). RISK-003: cascade delete on `prompt_id` means deleting a prompt deletes its history — acceptable while no `DELETE` grant on `prompt.prompt` exists at all; revisit in the slice that grants deletion.

## 10. Rollback

Run the down migration (AC-005, drilled); revert the commits. Dedup'd fixture rows stay gone — recorded, fixture-only.

## 11. Assumptions made during implementation

| ID | Assumption | Why |
|---|---|---|
| ASM-001 | T-I-005 and T-A-003 fixtures carry a `Date.now()` title suffix (`Fresh Version Fixture <ms>`, `Version Trail Fixture <ms>`) | Their Givens demand a genuinely fresh insert; with append-only history and no DELETE grant, a fixed title can never return to "at version 1" on a re-run. The clock names fixtures only — no assertion depends on time (J8 holds). One unique-titled row accumulates per run; the dedup does not remove them — same stance as RISK-002's fixture accumulation. |
| ASM-002 | The distinct-body guard lives inside `prompt.record_version()`, not a trigger `WHEN` clause | Postgres rejects `OLD` references in the `WHEN` condition of a trigger that also fires on insert; the spec's single-trigger phrasing ("the update branch fires only when …") is preserved with the guard as the function's first statement. |
| ASM-003 | AC-004's `42501` arrives as HTTP `403` with `code: "42501"` in the error body (PostgREST's insufficient_privilege mapping); T-I-006 asserts both | Confirmed live in the red run: the pre-grant PATCH in T-A-003 returned exactly this shape (`403`, body code `42501`). |
| ASM-004 | T-I-006's on-409 fixture PATCH writes a timestamp-distinct body | Red-phase runs insert `Immutable Fixture` before the trigger exists and the migration declares no backfill; a distinct-body update is what guarantees at least one version row exists to probe post-migration. |
| ASM-005 | Gap, flagged for the integrator's mutation drill: deleting the distinct-body guard turns no test red | The mutation only adds spurious version rows on same-body PATCHes, which none of the four declared tests observes. Recorded here instead of adding a fifth test beyond the declared plan (no scope widening mid-slice). |
| ASM-006 | Cross-user reads of `prompt_version` rest on the `owner_select` policy alone; no multi-user test probes it | The declared four-test plan is single-identity; NFR-003's executable probe remains T-I-003 on `prompt.prompt`. Flagged for the every-5-slices security review. |

## 12. Definition of Done

- [ ] AC-001..AC-004 tests green through the real API; red output recorded first.
- [ ] AC-005 round-trip drilled against the real project (integrator), evidence recorded.
- [ ] Amended skeleton tests green; their ledger rows carry the amendment note and date.
- [ ] Ledger rows predate tests; mutation verification recorded (integrator DDL mutations: drop the unique index → T-I-004 red; drop the trigger → T-I-005 red; grant update on `prompt_version` + policy → T-I-006 red; each reverted and re-proven green).
- [ ] Budget actuals filled; every line within ceiling.
- [ ] PRD: FR-002, FR-003 → `done`; change-log entry; NFR-005 → `done` for the version table (integrator applies).
- [ ] DFD and SYSTEM-REQUIREMENTS updated in the same integration commit (new table, new flow F-5 edit, immutability mechanism).
- [ ] Spec moved to `done/`, dates set.
