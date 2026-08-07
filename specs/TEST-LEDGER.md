---
title: Test Justification Ledger
status: active
created: 2026-08-07
updated: 2026-08-07
owner: Kyle
---

# Test Justification Ledger

> Every test in this repo has a row here, written **before** the test. A test with no row gets deleted at the next Test Review. A test is a liability that earns its keep by catching a specific failure a human would care about.

---

## 1. Active tests

| Test ID | Name / location | Level | Traces to | Failure mode caught | Why not cheaper | Why not duplicate | Mutation verified | Runtime (ms) | Deletion criterion | Added |
|---|---|---|---|---|---|---|---|---|---|---|
| T-A-001 | `tests/skeleton.test.mjs` | acceptance | AC-001, PROP-002 -> FR-001 | A saved body comes back altered (token, fence, newline, or non-ASCII corrupted), so every later render transforms corrupted input | Only a round-trip through the real API and storage can catch encoding loss | No other test reads a saved body back | 2026-08-07 (oracle mutation: expected body changed to fixture+`y`; red naming the exact diff, green on revert) | 800 | Never; the storage contract every slice assumes | SL-000 |
| T-I-001 | `tests/skeleton.test.mjs` | integration | AC-002, AC-003, PROP-003 -> FR-001 | A prompt outside FR-001's bounds (empty title, 201-char title, 100,001-char body) is stored | The `CHECK` is the cheap mechanism; this proves it is wired and survives future migrations | No other test sends invalid input | 2026-08-07 (dropped `prompt_title_check` via migration; red with actual `201` for an out-of-bounds title; constraint restored, the escaped empty-title row deleted) | 700 | FR-001's bounds change in the PRD | SL-000 |
| T-I-002 | `tests/skeleton.test.mjs` | integration | AC-004 -> NFR-003 | An unauthenticated caller reads prompt data (DR-002 is confidential) | RLS is database-level; only a real unauthenticated call proves it is switched on | No other test calls without a token | 2026-08-07 (owner policy replaced by `using (true)` via migration; red as anon received rows; policy restored, confirmed by `pg_policy` query) | 300 | Never while DR-002 is confidential | SL-000 |
| T-I-003 | `tests/skeleton.test.mjs` | integration | AC-005 -> NFR-003 | One user reads another user's prompts | Owner-scoped policy needs two real sessions; the positive control prevents a vacuous pass | No other test uses two identities | 2026-08-07 (same open-policy mutation; red as user B received user A's row; restored) | 900 | Tool becomes deliberately multi-user (PRD OOS-001 revisit) | SL-000 |
| T-A-002 | migration round-trip drill (manual, not executable) | acceptance | AC-006 -> CON-003 | The down migration strands the schema, table, or PostgREST exposure list | Only running the actual down proves rollback | Nothing else exercises the down | 2026-08-07 (down run against the real project: schema gone, `pgrst.db_schemas` back to exactly `public, core, idea`, confirmed by query; up re-applied, suite 4/4 green; DDL half also rehearsed on `lifeos-test` beforehand) | 0 (manual drill) | Never | SL-000 |

## 2. Level distribution

| Level | Count | Target share | Total runtime | Notes |
|---|---|---|---|---|
| Unit (`T-U-`) | 0 | ~70% | 0 | No pure logic exists yet; the skeleton is schema plus a fetch-and-render page. SL-002's render function is where units begin. |
| Property (in unit) | 1 | 1-3 per slice | 0.8s | PROP-002 round-trip inside T-A-001 |
| Integration (`T-I-`) | 3 | ~20% | 1.9s | |
| Acceptance (`T-A-`) | 2 | 1 per AC | 0.8s | T-A-001 executable; T-A-002 a recorded drill |
| E2E / Regression | 0 | | 0 | No defects yet; browser pass is a recorded drill, not a dependency |
| **Total** | 4 executable | | 1.9s | Phase 0 cap is 4 ✓; well under 120 s |

## 3. Regression register

| Test ID | Defect | Date found | How it reached production | Root cause | Fixed in | Also fixed by a cheaper mechanism? |
|---|---|---|---|---|---|---|

## 4. Deleted tests

| Test ID | Name | Deleted | Reason | Replaced by |
|---|---|---|---|---|

## 5. Quarantine

| Test ID | Reason quarantined | Quarantined on | Expires | Owner | Resolution |
|---|---|---|---|---|---|

Quarantine is capped at 14 days.

## 6. Ledger self-check (GATE-LEDGER)

- [x] Every test file has a matching row; every row's test exists. One file, four rows, plus the T-A-002 drill labelled as not executable.
- [x] Every `Traces to` resolves through an `AC`/`PROP` to an `FR`/`NFR`/`CON`.
- [x] Every row has a mutation-verified date and a deletion criterion. None `pending`.
- [x] Total suite runtime 1.9 s, under 120 s.
- [x] Quarantine empty.
