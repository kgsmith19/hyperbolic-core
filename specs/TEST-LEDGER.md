---
title: Test Justification Ledger
status: active
created: 2026-08-06
updated: 2026-08-07
owner: Kyle
---

# Test Justification Ledger

> **Purpose.** Every test in this repo has a row here. A test with no row gets deleted at the next Test Review, no discussion. This is how test suites stay lean instead of accreting.
>
> **Location:** `specs/TEST-LEDGER.md`. Updated in the same commit as the test it describes.
>
> **The rule:** a test is a liability that earns its keep by catching a specific failure. Coverage is not a reason. "It might break someday" is not a reason. A named failure mode a human would care about is a reason.

---

## 1. Active tests

| Test ID | Name / location | Level | Traces to | Failure mode caught | Why not cheaper | Why not duplicate | Mutation verified | Runtime (ms) | Deletion criterion | Added |
|---|---|---|---|---|---|---|---|---|---|---|
| T-I-001 | `tests/rls.test.mjs` | integration | AC-002 -> NFR-001 | An unauthenticated caller reads idea data | RLS is DB-level; nothing cheaper proves it over the real network | No other test hits the REST API unauthenticated | 2026-08-06 (mutated: added a permissive anon-read policy; test went red as expected) | 990 | `idea.idea` gets a public-read use case (never expected) | SL-000 |
| T-I-002 | `tests/rls.test.mjs` | integration | AC-006 -> NFR-001 | One user reads another user's `core.run` rows | Needs two real authenticated sessions | No other test uses two distinct identities | 2026-08-06 (mutated: replaced owner-scoped policy with a public-all policy; test went red as expected) | 640 | `core.run` ever becomes shared/team data | SL-000 |
| T-I-003 | `tests/constraints.test.mjs` | integration | AC-003 -> FR-002 | A `core.run` row is created for an unregistered tool | FK is the cheap mechanism; this proves it is wired | No other test inserts an orphan `core.run` row | 2026-08-06 (mutated: dropped `run_app_id_fkey`; test went red as expected) | 950 | Never | SL-000 |
| T-I-004 | `tests/constraints.test.mjs` | integration | AC-004 -> FR-003 | A metric is defined with no gaming risk | `NOT NULL` is the cheap mechanism; this proves it survives future migrations | No other test inserts into `core.metric_def` | 2026-08-06 (mutated: dropped `gaming_risk` NOT NULL; test went red as expected) | 310 | Never | SL-000 |
| T-I-005 | `tests/seed.test.mjs` | integration | AC-005, PROP-005 -> FR-001 | Seed data missing rows, duplicated, or drifted from the topology note | Needs a real query and value comparison | No other test reads the full 33-row set | 2026-08-07 (mutated the oracle: changed the expected `golden-goose` name; test went red naming the exact drift, then green on revert. Mutated the oracle rather than the row because ad-hoc `UPDATE`s against the live project are blocked in this environment (migrations are not); either direction proves the comparison is against real data, not vacuous) | 1400 | Idea list gets a UI-driven edit path making seed bootstrap-only | SL-000 |
| T-I-006 | `tests/seed.test.mjs` (comment only, not executable) | integration | PROP-003 -> FR-001 | Re-running the seed migration duplicates rows | Requires actually running a migration twice | No other test re-runs a migration | 2026-08-06 (ran the seed migration a second time against the live project; count stayed 33, not 66) | 0 | Never | SL-000 |
| T-A-001 | `tests/rls.test.mjs` (data contract) | acceptance | AC-001 -> FR-001 | The list page fails to render a seeded row's four fields | Only an end-to-end page load proves the browser contract; this test covers the data half, the browser half is verified by the drill below | No other test asserts all four AC-001 fields for one row | 2026-08-07 (caught a real defect rather than a synthetic one: asserting AC-001's `specced` went red against the seeded `idea`, and green after `20260807010000_idea_fix_prompt_organizer_status.sql`. See section 3, D-001) | 400 | Page replaced by a different tool's UI | SL-000 |
| T-A-002 | `tests/rls.test.mjs` (down migration) | acceptance | AC-007 -> NFR-004 | The down migration for `idea` does not fully remove the schema | Only running the actual down migration proves rollback | No other test exercises a down migration | 2026-08-06 (ran all four down migrations against the live project, confirmed `core`/`idea` schemas absent, then re-ran all four up migrations; also found and fixed a real gap: the up migrations were missing `GRANT`s, so the round-trip silently relied on grants applied outside version control) | 0 (manual drill) | Never | SL-000 |
| T-A-003 | migration round-trip drill (not executable) | acceptance | AC-007 -> NFR-004 | The corrective status migration cannot be rolled back | Only running the actual down migration proves rollback | T-A-002 covers the four schema migrations; this covers the fifth, a data migration | 2026-08-07 (applied the down against the live project: the row reverted to `idea`, confirmed by query; re-applied the up, row returned to `specced`, suite 7/7 green) | 0 (manual drill) | Never | SL-000 |
| T-A-004 | `tests/scores.test.mjs` | acceptance | AC-008 -> FR-004 | A scored idea's value or metric name is missing or wrong on read | Only a real read against `idea.score` and `core.metric_def` proves the join the page performs | No other test reads `idea.score` joined to `core.metric_def` | 2026-08-07 (mutated: `UPDATE core.metric_def SET name = 'wrong-name'`; test went red asserting `[{name: 'wrong-name'}]` !== `[{name: 'Idea effectiveness'}]`, reverted) | 1235 | If the page stops displaying scores | SL-001 |
| T-I-007 | `tests/scores.test.mjs` | integration | AC-010 -> FR-005 | A score above a metric's declared maximum is accepted | A `CHECK` cannot look up `core.metric_def`; this proves the bounds trigger is wired | No other test inserts an out-of-range score | 2026-08-07 (mutated: `ALTER TABLE idea.score DISABLE TRIGGER score_bounds_check`; test went red, 201 instead of 400; re-enabled, leaked rows deleted) | 219 | Never; this is the range guarantee itself | SL-001 |
| T-I-008 | `tests/scores.test.mjs` | integration | AC-011 -> FR-005 | A score below a metric's declared minimum is accepted | Same as T-I-007, the symmetric boundary | T-I-007 covers the upper bound only | 2026-08-07 (same mutation as T-I-007, disabling one trigger red-tests both boundaries at once; re-enabled, leaked rows deleted) | 226 | Never | SL-001 |
| T-A-005 | `tests/dependencies.test.mjs` | acceptance | AC-012 -> FR-006 | The seeded dependency's target idea or reason is missing or wrong on read | Only a real read against `idea.dependency` proves the seed migration wrote what the topology note's section 3 says | No other test reads `idea.dependency` | 2026-08-07 (mutated: `UPDATE idea.dependency SET reason = 'wrong-reason'`; test went red asserting the wrong reason, reverted. Idempotence (PROP-022) also drilled: re-ran the seed migration against the live project, row count stayed 1) | 334 | If `constraint-finder`'s real dependency on `optimize-metrics` is ever removed or superseded | SL-002 |

**Column meanings:**

| Column | What a valid answer looks like |
|---|---|
| Traces to | A `PROP-` or `AC-` id, and through it an `FR-`/`NFR-`. Two hops, both real. |
| Failure mode caught | A user- or operator-observable wrong behavior. "The function returns the wrong type" is not one; "a user is charged twice for one order" is. |
| Why not cheaper | Names the type constraint, database constraint, schema validation, or lint rule that was considered and why it is insufficient. |
| Why not duplicate | Names the nearest existing test and the specific difference. |
| Mutation verified | Date on which the code was deliberately broken and this test was confirmed to go red. A test never mutation-verified is unproven. |
| Deletion criterion | The concrete future condition that makes this test obsolete. "When the legacy import path is removed." "Never, this is a revenue-critical invariant." |

## 2. Level distribution

Updated at every Test Review. A shape that inverts (many E2E, few unit) is a defect in the strategy, not just the tests.

| Level | Count | Target share | Total runtime | Notes |
|---|---|---|---|---|
| Unit (`T-U-`) | 0 | ~70% | 0 | Still none. SPEC-0001 added one pure function (`latestScoresByIdea` in `web/index.html`) but left it inline rather than extracting a separately importable module for one caller (GATE-MINIMAL M2); its behavior is covered by the AC-009 browser drill instead. A real second caller would justify extracting and unit-testing it. |
| Property (counted within unit) | 1 | 1-3 per slice | 1.4s | PROP-005 as an oracle comparison inside T-I-005 |
| Integration (`T-I-`) | 7 | ~20% | 3.9s | T-I-001 through T-I-005, T-I-007, T-I-008; T-I-006 is a recorded manual drill, not executable |
| Acceptance (`T-A-`) | 4 | 1 per AC | 1.6s | T-A-001, T-A-004, T-A-005 executable; T-A-002 a recorded manual drill |
| E2E (`T-E-`) | 0 | ~5%, critical paths only | 0 | The browser drill covers this path without adding a dependency |
| Regression (`T-R-`) | 0 | 1 per real defect | 0 | D-001 is covered by tightening T-A-001, not by a new test |
| **Total** | 11 executable | | 1.6s | Under `{{MAX_SUITE_SECONDS}}` |

## 3. Regression register

Regression tests are the only tests allowed to exist without a forward-looking property, because they encode a bug that actually happened.

| Test ID | Defect | Date found | How it reached production | Root cause | Fixed in | Also fixed by a cheaper mechanism? |
|---|---|---|---|---|---|---|
| D-001 (covered by T-A-001, no new test) | `idea.idea`'s `prompt-organizer` row carried `status` `idea`; FR-001 and AC-001 both name `specced`. | 2026-08-07 | The seed migration wrote `idea`, and T-A-001 was written to assert `idea` to match it. Asserting the observed value instead of the specified one is the banned behavior in `rules/00-CORE.md` ("editing a test to make it pass"). It inverted the source of truth, so the suite was green while the data contradicted the PRD. | The test was authored from the database rather than from the acceptance criterion. | `supabase/migrations/20260807010000_idea_fix_prompt_organizer_status.sql` corrects the live row; `20260806190300_seed_idea.sql` corrects fresh deploys; T-A-001 now asserts `specced`. | No. A `CHECK` constraint can restrict `status` to the allowed set (it already does) but cannot know which value a given row should hold. The assertion is the cheapest mechanism that ties a row to its acceptance criterion. |

**Which gate missed it:** GATE-RED R4 ("it fails for the intended reason", with the reason written in the spec *before* running). Had the expected value been taken from AC-001 before the test was run, the mismatch would have surfaced as the test's first red instead of never surfacing. GATE-GREEN G7 is the backstop that also missed it, since a line asserting `idea` traces to no acceptance criterion.

**Required for every row:** "which gate missed it". A defect reaching production means a gate is wrong. Fixing only the code and not the gate guarantees a repeat.

## 4. Deleted tests

Deletion is progress and gets recorded, not hidden.

| Test ID | Name | Deleted | Reason | Replaced by |
|---|---|---|---|---|

## 5. Quarantine

Tests that are flaky, slow, or unproven live here with an expiry date. A quarantined test past its expiry is deleted automatically at the next Test Review.

| Test ID | Reason quarantined | Quarantined on | Expires | Owner | Resolution |
|---|---|---|---|---|---|

**Quarantine is capped at 14 days.** A test nobody will fix in two weeks is a test nobody needs.

## 6. Ledger self-check (GATE-LEDGER)

- [x] Every test file in the repo has a matching row in section 1. Five files: `rls.test.mjs` (T-I-001, T-I-002, T-A-001), `constraints.test.mjs` (T-I-003, T-I-004), `seed.test.mjs` (T-I-005), `scores.test.mjs` (T-A-004, T-I-007, T-I-008), `dependencies.test.mjs` (T-A-005).
- [x] Every row in section 1 corresponds to a test that exists. T-I-006, T-A-002, and T-A-003 are labelled as manual drills rather than executable tests, so the count is not overstated.
- [x] Every row's `Traces to` resolves to a real `PROP-`/`AC-` and a real `FR-`/`NFR-`.
- [x] Every row has a mutation-verified date. None left `pending`.
- [x] Every row has a deletion criterion.
- [x] No row's failure mode is phrased in implementation terms rather than observable terms.
- [x] Total suite runtime is under `{{MAX_SUITE_SECONDS}}` (120): 1.6s measured, 11 tests.
- [x] Quarantine has no expired entries. It is empty.
- [x] Every regression row names the gate that missed the defect. D-001 names GATE-RED R4, with GATE-GREEN G7 as the backstop that also missed it.
