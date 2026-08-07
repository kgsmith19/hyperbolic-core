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
| T-A-001 | `tests/skeleton.test.mjs` — **amended 2026-08-07, SPEC-0002 7.3 (declared, never silent):** "T-A-001 and T-I-003 re-insert fixed titles (`Spec Author`, `rls probe`) every run; under the unique index the second run collides. Amended flow, same contracts: `POST`; on `409`, `PATCH` the body by title instead. T-A-001's round-trip read-back stays byte-identical (its AC unchanged) and now also exercises the FR-003 update path on re-runs. The tests were correct for SL-000's world; the world legitimately changed — recorded here, not silently." | acceptance | AC-001, PROP-002 -> FR-001 | A saved body comes back altered (token, fence, newline, or non-ASCII corrupted), so every later render transforms corrupted input | Only a round-trip through the real API and storage can catch encoding loss | No other test reads a saved body back | 2026-08-07 (oracle mutation: expected body changed to fixture+`y`; red naming the exact diff, green on revert) | 800 | Never; the storage contract every slice assumes | SL-000 |
| T-I-001 | `tests/skeleton.test.mjs` | integration | AC-002, AC-003, PROP-003 -> FR-001 | A prompt outside FR-001's bounds (empty title, 201-char title, 100,001-char body) is stored | The `CHECK` is the cheap mechanism; this proves it is wired and survives future migrations | No other test sends invalid input | 2026-08-07 (dropped `prompt_title_check` via migration; red with actual `201` for an out-of-bounds title; constraint restored, the escaped empty-title row deleted) | 700 | FR-001's bounds change in the PRD | SL-000 |
| T-I-002 | `tests/skeleton.test.mjs` | integration | AC-004 -> NFR-003 | An unauthenticated caller reads prompt data (DR-002 is confidential) | RLS is database-level; only a real unauthenticated call proves it is switched on | No other test calls without a token | 2026-08-07 (owner policy replaced by `using (true)` via migration; red as anon received rows; policy restored, confirmed by `pg_policy` query) | 300 | Never while DR-002 is confidential | SL-000 |
| T-I-003 | `tests/skeleton.test.mjs` — **amended 2026-08-07, SPEC-0002 7.3 (declared, never silent):** "T-A-001 and T-I-003 re-insert fixed titles (`Spec Author`, `rls probe`) every run; under the unique index the second run collides. Amended flow, same contracts: `POST`; on `409`, `PATCH` the body by title instead. T-I-003's isolation assertions are unchanged. The tests were correct for SL-000's world; the world legitimately changed — recorded here, not silently." | integration | AC-005 -> NFR-003 | One user reads another user's prompts | Owner-scoped policy needs two real sessions; the positive control prevents a vacuous pass | No other test uses two identities | 2026-08-07 (same open-policy mutation; red as user B received user A's row; restored) | 900 | Tool becomes deliberately multi-user (PRD OOS-001 revisit) | SL-000 |
| T-A-002 | migration round-trip drill (manual, not executable) | acceptance | AC-006 -> CON-003 | The down migration strands the schema, table, or PostgREST exposure list | Only running the actual down proves rollback | Nothing else exercises the down | 2026-08-07 (down run against the real project: schema gone, `pgrst.db_schemas` back to exactly `public, core, idea`, confirmed by query; up re-applied, suite 4/4 green; DDL half also rehearsed on `lifeos-test` beforehand) | 0 (manual drill) | Never | SL-000 |
| T-U-001 | `tests/search.test.mjs` `matches_on_title_or_body_case_insensitively` | unit | AC-001, AC-002, PROP-002 -> FR-006 | A prompt that matches the search is hidden, or one that does not match is shown | Pure function; unit is the cheapest level | First test of this function | 2026-08-07 (case-fold removed from both sides: `SPEC` matched nothing; red expected `['Bug Fixer','Spec Author']` actual `[]`; reverted) | 3 | FR-006 changes shape (tags, SL-006) — then extended, not deleted | SL-001 |
| T-U-002 | `tests/search.test.mjs` `ranks_title_match_above_body_only_match` | unit | AC-001, PROP-004 -> FR-006 | A body-only match ranks above a title match | Ordering is logic, not wiring | T-U-001 asserts membership, this asserts order | 2026-08-07 (rank sort removed — one pass in input order; only this test red: actual `['Bug Fixer','Spec Author']` vs expected `['Spec Author','Bug Fixer']`; reverted) | 1 | Same as T-U-001 | SL-001 |
| T-U-003 | `tests/search.test.mjs` `returns_no_prompts_for_query_matching_nothing` | unit | AC-003 -> FR-006 | A no-match query returns rows anyway | Pure function; unit is the cheapest level | Only no-match case | 2026-08-07 (query ignored — `q` forced to `""` so everything matches; red expected `[]` actual all 3 fixture rows; reverted) | 1 | Same as T-U-001 | SL-001 |
| T-U-004 | `tests/search.test.mjs` `clearing_the_search_restores_all_prompts_unchanged` | unit | AC-004, PROP-003 -> FR-006 | Filtering mutates the list or loses rows on clear | Pure function; unit is the cheapest level | Only clear/identity case | 2026-08-07 (in-place `splice` filter returning the input; red — verified in isolation too: the cleared call was missing `Daily Journal`; reverted) | 1 | Same as T-U-001 | SL-001 |
| T-U-005 | `tests/search.test.mjs` `treats_metacharacter_and_non_ascii_queries_as_literal_text` | unit | PROP-001 -> FR-006 | A regex-metacharacter or non-ASCII query crashes or misfilters | Pure function; this is where literal-vs-pattern bugs live | Only adversarial-input case | 2026-08-07 (query compiled as `new RegExp(query, "i")`; only this test red: SyntaxError `Unterminated group` on the `(` probe; reverted) | 2 | Same as T-U-001 | SL-001 |
| T-I-004 | `tests/versions.test.mjs` | integration | AC-001, PROP-001 -> FR-002 | Two prompts share a title (case-folded), so title-as-key (FR-013) becomes ambiguous | The unique index is the mechanism; this proves it is wired through the real API | Only duplicate-title test | 2026-08-07 (integrator: dropped `prompt_title_unique` via migration; red — duplicate insert `201` not `409`; index restored after deduping rows the mutation window let collide) | 500 | FR-002 changes | SL-004 |
| T-I-005 | `tests/versions.test.mjs` | integration | AC-002, PROP-004 -> FR-003 | An insert records no version, so history starts at the first edit and the original is unrecoverable | Trigger behavior needs the real database | Only insert-version test | 2026-08-07 (integrator: dropped the `record_version` trigger via migration; red; trigger restored) | 280 | FR-003 changes | SL-004 |
| T-A-003 | `tests/versions.test.mjs` | acceptance | AC-003, PROP-002, PROP-003 -> FR-003 | An edit overwrites history (version 1 lost or altered) — UC-004's exact loss | End-to-end through the API is the AC as written | Only update-version test | 2026-08-07 (integrator: same trigger-drop mutation as T-I-005; red; restored) | 400 | FR-003 changes | SL-004 |
| T-I-006 | `tests/versions.test.mjs` | integration | AC-004, PROP-002 -> NFR-005 | A stored version is changed or deleted after the fact | Grant/policy absence is the mechanism; this proves both probes are rejected | Only immutability test | 2026-08-07 (integrator: granted `UPDATE` + an owner policy on `prompt_version` via migration; red; grant and policy reverted) | 630 | NFR-005 changes | SL-004 |
| T-I-007 | `tests/versions.test.mjs` | integration | PROP-003 -> FR-003 | A no-op body update (same value) appends a spurious version — PROP-003's "per body change" broken by "per body-update statement" | The trigger's distinct-body guard is the mechanism; only a live `UPDATE` proves the column-list trigger's actual firing semantics | No other test issues a same-value update | 2026-08-07 (integrator, added mid-review: the guard's own removal survived the full 8-test suite green — a real coverage hole GATE-TEST-JUSTIFIED J6 exists to catch. Guard removed via migration; new test red — `version_no` 2 present where 1 was expected; guard restored, suite 9/9 green) | 260 | Never; this is the invariant the trigger exists to hold | SL-004 |

## 2. Level distribution

| Level | Count | Target share | Total runtime | Notes |
|---|---|---|---|---|
| Unit (`T-U-`) | 5 | ~70% | 8ms | SL-001's `searchPrompts` (T-U-001..005): example probes over the SPEC-0001 PROP-001..004 domains |
| Property (in unit) | 1 | 1-3 per slice | 0.8s | PROP-002 round-trip inside T-A-001 |
| Integration (`T-I-`) | 7 | ~20% | ~3s | T-I-001..003 (SL-000), T-I-004..007 (SL-004) |
| Acceptance (`T-A-`) | 3 | 1 per AC | ~1.2s + drill | T-A-001, T-A-003 executable; T-A-002 a recorded drill |
| E2E / Regression | 0 | | 0 | No defects yet; browser pass is a recorded drill, not a dependency |
| **Total (SL-000+SL-001+SL-004)** | 14 executable | | 2.49s measured (`node --test "tests/*.test.mjs"` on integrated `main`, commit 750b4ab) | Phase 0 cap (4) applied to SL-000 only; SL-001 and SL-004 declare standard ceilings; well under 120 s |

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

- [x] Every test file has a matching row; every row's test exists. Three files (`skeleton.test.mjs`, `search.test.mjs`, `versions.test.mjs`), fourteen executable rows, plus the T-A-002 drill labelled as not executable.
- [x] Every `Traces to` resolves through an `AC`/`PROP` to an `FR`/`NFR`/`CON`.
- [x] Every row has a mutation-verified date and a deletion criterion. All SL-004 rows verified 2026-08-07 by the integrator (DDL mutations, since the worker's task deliberately excluded schema access). None `pending`.
- [x] Total suite runtime 2.49s measured on integrated `main`, under 120 s.
- [x] Quarantine empty.
