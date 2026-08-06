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
