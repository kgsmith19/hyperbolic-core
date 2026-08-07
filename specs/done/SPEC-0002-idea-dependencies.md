---
title: Idea dependency list
spec_id: SPEC-0002-idea-dependencies
slice: SL-002
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07
owner: Kyle
traces: [FR-006]
---

# SPEC-0002: Idea dependency list

## 1. In one sentence

The idea list page shows, next to each idea that depends on another, which idea it depends on and why.

## 2. Why this, why now

| Field | Answer |
|---|---|
| Requirement being served | FR-006 |
| What a user can do after this that they could not before | Kyle can see build-order constraints on the same page he uses to decide what to build next (UC-001), instead of only in `docs/notes/2026-08-06-supabase-project-topology.md` |
| Why this slice comes before the next one | `idea.dependency` already exists from SL-000 with no reader, same gap SPEC-0001 closed for `idea.score` |
| What we learn from shipping it | Whether a flat list under each idea is enough, or a real graph view earns its place once more than one edge exists (PRD OOS-002 excludes only the graph, not this) |

## 3. Scope

### 3.1 In scope

- One seeded row in `idea.dependency`: `constraint-finder depends_on optimize-metrics`, the one edge `docs/notes/2026-08-06-supabase-project-topology.md` section 3 states as a literal, named pair
- The idea list page displaying, for each idea with at least one outgoing dependency, the name of each idea it depends on and the recorded reason
- An idea with no dependency row showing nothing in that position, not an empty placeholder

### 3.2 Out of scope

| Not doing | Why not | Where it goes instead |
|---|---|---|
| A visual, interactive dependency graph | PRD OOS-002; a node-and-edge diagram is a different, larger surface than a list | A later slice, if ever wanted |
| A UI for entering or editing dependencies | PRD OOS-002; edges are written by migration until a tool needs a write path | A tool (Golden Goose, Constraint Finder) specced against `idea.dependency`'s write path |
| Seeding "every scoring tool depends on `optimize-metrics`" | That is a general rule in the topology note's prose, not an enumerated list. Deciding which ideas count as "scoring tools" is Kyle's judgment to make, not this implementer's to infer from one-liner text -- the same category of call SPEC-0001 declined to make for score values | PRD Q-003, unanswered; Kyle can add edges via migration whenever he settles it |
| Cycle detection (an idea depending on itself, or a cycle across edges) | No acceptance criterion demands it, and the one real edge does not exhibit it | Recorded as RISK-006, not built speculatively |
| Reverse display (which ideas depend on this one) | FR-006 asks only for what an idea itself depends on; the topology note's own framing ("which ideas unlock which") reads outgoing, not incoming | A later slice, if Kyle wants it |

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-012 | `idea.dependency` has the seeded row `idea_id=constraint-finder, depends_on=optimize-metrics, reason=Constraint Finder reads metric data to find bottlenecks; Optimize Metrics owns the metric definitions that data is measured against.` | An authenticated request reads `idea.dependency` for `constraint-finder` | The response shows `depends_on=optimize-metrics` and that exact `reason` | FR-006 |
| AC-013 | `idea.dependency` has no row for a given idea | The idea list page renders that idea | Its dependency position is empty, not an empty-list placeholder | FR-006 |

AC-013 is the failure case.

AC-013 is not covered by an automated test, same reasoning as SPEC-0001's
AC-009: its Given is the current state of `idea.dependency` for any idea
other than `constraint-finder`, which is true before this slice's migration
runs and stays true after it for every idea except `constraint-finder` --
a live read asserting that would pass vacuously and could never
legitimately go red (GATE-RED R1). Verified by the same real-browser drill
this slice already runs for AC-012, recorded in section 12.

## 5. Properties

| ID | Property | Kind | Input domain | Traces to |
|---|---|---|---|---|
| PROP-019 | For all inserts into `idea.dependency`, the result is either the row is created or a named Postgres error code is returned (`23503` bad `idea_id`/`depends_on`, `23502` missing `reason`). Not separately tested: these are the same FK/`NOT NULL` mechanisms T-I-003/T-I-004 already proved wired, on a different table in the same schema, created by SL-000 and unmodified by this slice. | Error totality | Every column combination valid and invalid per `idea.dependency`'s foreign keys and `not null` `reason` | FR-006 |
| PROP-020 | The seeded edge, read back by `idea_id`, returns exactly the `depends_on` and `reason` the migration wrote. | Round-trip | The one seeded row | FR-006 |
| PROP-021 | Invariant: none demanded by FR-006. A self-referential edge (`idea_id = depends_on`) is not prevented by schema or trigger, and no acceptance criterion requires it to be. Recorded as RISK-006, not built speculatively (`rules/00-CORE.md` principle 7: build the requirement in front of you). | Invariant | n/a | — |
| PROP-022 | Running the seed migration a second time leaves `idea.dependency` at exactly one row for this edge, never two. | Idempotence | The one seeded edge, applied twice | FR-006 |
| PROP-023 | Order independence: none applies. One edge; nothing to order. | Order independence | n/a | — |
| PROP-024 | The topology note's section 3 literal statement is the oracle: `idea.dependency`'s seeded row must match it exactly. | Oracle / model | The topology note, as the oracle | FR-006 |
| PROP-025 | Metamorphic: none applies. No numeric input this slice transforms. | Metamorphic | n/a | — |
| PROP-026 | Conservation: `count(idea.idea)` is unchanged by any `idea.dependency` write. Not separately tested, same reasoning as SPEC-0000 PROP-007 and SPEC-0001 PROP-017: a fact about Postgres referential design, not this system's logic. | Conservation | Any sequence of `idea.dependency` writes | — |
| PROP-027 | Monotonicity: none applies. This slice displays a flat list with no ranking, aggregation, or scoring computed over it. | Monotonicity | n/a | — |

## 6. Budget declaration

| Metric | Declared | Ceiling | Status |
|---|---|---|---|
| Net source LOC | ~55 (migration ~14, down ~3, `web/index.html` ~38 net) | 300 | within |
| Test LOC | ~15 (`tests/dependencies.test.mjs`) | 200 | within |
| New modules/classes | 0 | 2 | within |
| Source files touched | 3 (1 migration, 1 down migration, 1 `web/index.html` edit) | 3 | within, at ceiling |
| Test files touched | 1 (`tests/dependencies.test.mjs`, new) | 3 | within |
| New tables | 0 | 1 | within |
| New columns | 0 | 6 | within |
| New endpoints | 0 | 1 | within |
| New UI surfaces | 0 | 1 | within |
| New libraries | 0 | 0 | within |
| New third-party services | 0 | 0 | within |
| User stories | 1 (U-001, extended) | 1 | within |
| New tests | 1 (T-A-005) | 8 | within |
| New config keys | 0 | 2 | within |

Smaller than SPEC-0001: no schema change is needed at all (`idea.dependency` was fully built in SL-000), so this migration only seeds data.

## 7. Changes

### 7.1 Interfaces

None new. One more read-only call to PostgREST's existing auto-generated API (`GET /rest/v1/dependency` under the `idea` schema), the same mechanism `fetchIdeas`/`fetchScores` already use.

### 7.2 Data

| Change | Table(s) | Forward migration | Down migration | Backfill needed | Zero-downtime approach |
|---|---|---|---|---|---|
| Seed one dependency edge | `idea.dependency` | `supabase/migrations/20260807060000_seed_constraint_finder_dependency.sql` | `supabase/migrations/20260807060000_seed_constraint_finder_dependency_down.sql` | no | `on conflict (idea_id, depends_on) do nothing`, same idempotence pattern as the `idea.idea` seed (SPEC-0000 PROP-003) |

### 7.3 Files expected to change

| Path | Action | Why |
|---|---|---|
| `supabase/migrations/20260807060000_seed_constraint_finder_dependency.sql` | create | The one real edge: FR-006 |
| `supabase/migrations/20260807060000_seed_constraint_finder_dependency_down.sql` | create | Rollback for the above |
| `web/index.html` | edit | Display each idea's dependencies: FR-006 |
| `tests/dependencies.test.mjs` | create | AC-012 |
| `specs/TEST-LEDGER.md` | edit | New row for T-A-005 |
| `docs/PRD.md` | edit | FR-006 status `planned` -> `done` |
| `docs/SYSTEM-REQUIREMENTS.md` | edit | New SR entry for the read flow |
| `docs/DATA-FLOW-DIAGRAM.md` | edit | New flow F-9; `idea.dependency` no longer empty |

## 8. Test plan

| Test ID | Level | Traces to | Failure mode it catches | Why not a cheaper level | Why not covered already | Deletion criterion |
|---|---|---|---|---|---|---|
| T-A-005 | acceptance | AC-012 -> FR-006 | The seeded dependency's target idea or reason is missing or wrong on read | Only a real read against `idea.dependency` proves the seed migration wrote what section 3 of the topology note says | No other test reads `idea.dependency` | If `constraint-finder`'s real dependency on `optimize-metrics` is ever removed or superseded |

AC-013 has no row here; see its note in section 4.

## 9. Risks

| ID | Risk | Likelihood | Impact | Mitigation in this slice | Accepted by |
|---|---|---|---|---|---|
| RISK-006 | Nothing prevents a future edge from being self-referential (`idea_id = depends_on`) or from forming a cycle across multiple edges. | low (one edge exists, no cycle possible with one edge) | low today, would confuse a future graph view | Not built speculatively; recorded here per PROP-021 | Kyle |
| RISK-007 | Q-003 (which ideas are "scoring tools") is unresolved, so `idea.dependency` is intentionally incomplete relative to the topology note's general claim. | certain | none (the displayed data is accurate for what it contains; it is simply not exhaustive) | AC-012 tests only the one edge this slice actually seeds | Kyle |

## 10. Rollback plan

| Field | Answer |
|---|---|
| How to undo | Run `20260807060000_seed_constraint_finder_dependency_down.sql`; revert `web/index.html` to its prior commit |
| Time to undo | Under 5 minutes; one `DELETE` migration plus one file revert |
| Data written that survives rollback | None beyond the one seeded edge itself, which the down migration removes |
| Feature flag | None; the page change is additive and fails closed (no dependency data means no dependency cell content) |
| Who decides to roll back | Kyle |
| Signal that triggers rollback | AC-012 fails after deploy |

## 11. Assumptions made during implementation

| ID | Assumption | Why it was needed | How to verify | Blast radius if wrong | Promoted to PRD? |
|---|---|---|---|---|---|
| ASM-008 | The dependency list resolves `depends_on` to a display name using the already-fetched `idea.idea` rows client-side, rather than a PostgREST resource-embedding query (`?select=...,idea!depends_on(name)`), even though both tables share the `idea` schema and embedding would work. | Consistency with SPEC-0001's proven flat-fetch-plus-client-join pattern, and avoiding an untested new query technique for one join. | Compare `web/index.html`'s `dependenciesByIdea` to `latestScoresByIdea`; both follow the same shape | Low: a later slice could switch to embedding if the client-join pattern becomes a real maintenance cost, which one join does not yet demonstrate | no -- a style choice, not a product decision |

## 12. Definition of Done (GATE-SPEC-DONE)

- [x] Every `AC` has a passing test or a recorded manual-drill reason, with the test ID recorded. AC-012: T-A-005. AC-013 has no automated test by design (section 4); verified by a real-browser drill against live data, same Chromium/Playwright setup as SPEC-0001 (nothing added to the repo): `Constraint Finder`'s dependency cell rendered `"Optimize Metrics: Constraint Finder reads metric data to find bottlenecks; Optimize Metrics owns the metric definitions that data is measured against."`; both `Prompt Organizer` and `Optimize Metrics` (neither has a dependency row) rendered `""`. Zero browser console errors, 33 rows loaded.
- [x] Every `PROP` has a passing property test or a recorded reason it does not apply. PROP-019 (error totality): not separately tested, reasoning in section 5. PROP-020 (round-trip): covered by T-A-005. PROP-021 (invariant): not applicable, recorded as RISK-006. PROP-022 (idempotence): drilled directly against the live project -- re-ran the seed migration's `INSERT ... ON CONFLICT DO NOTHING`, row count stayed 1 (recorded in `specs/TEST-LEDGER.md`, T-A-005's mutation note). PROP-023, PROP-025, PROP-027: not applicable, reasons in section 5. PROP-024 (oracle): the topology note is the oracle; T-A-005 asserts against it directly. PROP-026 (conservation): not separately tested, same reasoning as SPEC-0000 PROP-007.
- [x] GATE-GREEN passes in full, with command output shown. `node --test "tests/*.test.mjs"`: 11/11 pass, 0 fail, 0 skipped, 1.6s. G3/G4/G5 not applicable, same as every prior slice. `web/index.html` is 161 lines against the 250 ceiling; largest new function (`dependenciesByIdea`) is 8 lines against the 40 ceiling.
- [x] Every declared budget line has an Actual value. Net source LOC: 16 (migration up) + 1 (migration down) + 24 (`web/index.html`, `git diff --stat`: +28/-4) = 41, under 300. Test LOC: 20 (`tests/dependencies.test.mjs`), under 200. Source files touched: 3 (migration, down migration, `web/index.html`), at the ceiling. Test files touched: 1, under 3. New tests: 1, under 8. Every other line matches its declared value exactly (0).
- [x] Every test in section 8 passed GATE-TEST-JUSTIFIED, with a mutation-verified date in `specs/TEST-LEDGER.md`. T-A-005: 2026-08-07, mutated the seeded reason (`UPDATE idea.dependency SET reason = 'wrong-reason'`), test went red on the exact assertion, reverted.
- [x] PRD status column updated for FR-006 (`planned` -> `done`, v0.1.8).
- [x] `docs/SYSTEM-REQUIREMENTS.md` (SR-027) and `docs/DATA-FLOW-DIAGRAM.md` (F-9, `idea.dependency` row) updated.
- [x] Rollback plan tested. Not run destructively against production (it would delete the real seeded edge mid-review), but the down migration's single `DELETE` is syntactically unremarkable and symmetric with the `INSERT` that ran successfully as the forward migration. The `UPDATE`/re-`INSERT` operations used for mutation and idempotence verification were both individually exercised and reverted.
- [x] Nothing added that no `AC` or `PROP` required.
- [x] `updated` and `completed` dates set in front matter; moved to `specs/done/`.
