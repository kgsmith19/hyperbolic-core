---
title: Test Justification Ledger
status: active
created: 2026-08-06
updated: 2026-08-06
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
| T-I-001 | `tests/rls.test.mjs` | integration | AC-002 -> NFR-001 | An unauthenticated caller reads idea data | RLS is DB-level; nothing cheaper proves it over the real network | No other test hits the REST API unauthenticated | pending | | `idea.idea` gets a public-read use case (never expected) | SL-000 |
| T-I-002 | `tests/rls.test.mjs` | integration | AC-006 -> NFR-001 | One user reads another user's `core.run` rows | Needs two real authenticated sessions | No other test uses two distinct identities | pending | | `core.run` ever becomes shared/team data | SL-000 |
| T-I-003 | `tests/constraints.test.mjs` | integration | AC-003 -> FR-002 | A `core.run` row is created for an unregistered tool | FK is the cheap mechanism; this proves it is wired | No other test inserts an orphan `core.run` row | pending | | Never | SL-000 |
| T-I-004 | `tests/constraints.test.mjs` | integration | AC-004 -> FR-003 | A metric is defined with no gaming risk | `NOT NULL` is the cheap mechanism; this proves it survives future migrations | No other test inserts into `core.metric_def` | pending | | Never | SL-000 |
| T-I-005 | `tests/seed.test.mjs` | integration | AC-005, PROP-005 -> FR-001 | Seed data missing rows, duplicated, or drifted from the topology note | Needs a real query and value comparison | No other test reads the full 33-row set | pending | | Idea list gets a UI-driven edit path making seed bootstrap-only | SL-000 |
| T-I-006 | `tests/seed.test.mjs` | integration | PROP-003 -> FR-001 | Re-running the seed migration duplicates rows | Requires actually running a migration twice | No other test re-runs a migration | pending | | Never | SL-000 |
| T-A-001 | `tests/rls.test.mjs` (page load) | acceptance | AC-001 -> FR-001 | The list page fails to render a seeded row's fields | Only an end-to-end page load proves the browser contract | No other test loads the actual HTML page | pending | | Page replaced by a different tool's UI | SL-000 |
| T-A-002 | `tests/rls.test.mjs` (down migration) | acceptance | AC-007 -> NFR-004 | The down migration for `idea` does not fully remove the schema | Only running the actual down migration proves rollback | No other test exercises a down migration | pending | | Never | SL-000 |

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
| Unit (`T-U-`) | | ~70% | | |
| Property (counted within unit) | | 1-3 per slice | | |
| Integration (`T-I-`) | | ~20% | | |
| Acceptance (`T-A-`) | | 1 per AC | | |
| E2E (`T-E-`) | | ~5%, critical paths only | | |
| Regression (`T-R-`) | | 1 per real defect | | |
| **Total** | | | | must be under `{{MAX_SUITE_SECONDS}}` |

## 3. Regression register

Regression tests are the only tests allowed to exist without a forward-looking property, because they encode a bug that actually happened.

| Test ID | Defect | Date found | How it reached production | Root cause | Fixed in | Also fixed by a cheaper mechanism? |
|---|---|---|---|---|---|---|

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

- [ ] Every test file in the repo has a matching row in section 1.
- [ ] Every row in section 1 corresponds to a test that exists.
- [ ] Every row's `Traces to` resolves to a real `PROP-`/`AC-` and a real `FR-`/`NFR-`.
- [ ] Every row has a mutation-verified date.
- [ ] Every row has a deletion criterion.
- [ ] No row's failure mode is phrased in implementation terms rather than observable terms.
- [ ] Total suite runtime is under `{{MAX_SUITE_SECONDS}}`.
- [ ] Quarantine has no expired entries.
- [ ] Every regression row names the gate that missed the defect.
