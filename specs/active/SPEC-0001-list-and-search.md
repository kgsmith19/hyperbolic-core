---
title: Search the prompt list by title and body
spec_id: SPEC-0001-list-and-search
slice: SL-001
status: active
created: 2026-08-07
updated: 2026-08-07
completed:
owner: Kyle
traces: [FR-006, NFR-009]
---

# SPEC-0001: Search the prompt list by title and body

## 1. In one sentence

A search box above the prompt list filters it, case-insensitively, to prompts whose title or body contains the typed string, title matches first.

## 2. Why this, why now

FR-006 (partial: no tags — tags are SL-006). With more than a handful of prompts saved, the list is already scan-hostile; search is what makes saving prompts better than a text file. Delivers the PRD's SL-001.

## 3. Scope

**In:** a search input on the page; client-side filtering of the already-loaded list (the page fetches all rows today; with ASM-001's ~300-prompt bound, client-side is the cheapest sufficient mechanism — no new endpoint, no query round-trip); ranking (title-match group before body-only group, stable within groups); an empty state naming the search and prefilling the title field with it (UC-001's failure path).

**Out (three entries per S4):** tag search and tag filter (SL-006); server-side or semantic search (PRD Q-004 default: full text, and client-side suffices at this scale); highlighting matches in results (no AC demands it); NFR-001's 300 ms @ 1,000-prompt threshold (measured when a seeded 1,000-row library exists; the filter is a pure function over an in-memory array, so the risk lives in the initial fetch, not here).

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-001 | Prompts exist: `Spec Author` (body `writes specs`), `Bug Fixer` (body `fix a spec defect`), `Daily Journal` (body `morning pages`) | Searching `spec` | Exactly `Spec Author` then `Bug Fixer` are shown, in that order (title match ranks above body-only match); `Daily Journal` is absent | FR-006 |
| AC-002 | Same prompts | Searching `SPEC` (upper case) | Same result as AC-001 (matching is case-insensitive) | FR-006 |
| AC-003 | Same prompts | Searching `zzz-none` | Zero prompts shown; the empty state reads exactly `No prompts match "zzz-none"`; the save form's title field is prefilled with `zzz-none` | FR-006, UC-001 |
| AC-004 | A search has filtered the list | The search input is cleared | Every prompt is shown again in the original order (filtering never mutates the list) | FR-006 |

AC-003 is the failure case.

## 5. Properties (all nine walked)

| ID | Property | Kind | Domain | Traces |
|---|---|---|---|---|
| PROP-001 | For every query string, the filter returns a subset of the input in finite time — never a crash; empty query returns the whole input unchanged. | Error totality | Queries: empty, 1 char, whitespace, regex metacharacters (`.*`, `(`), quotes, non-ASCII `é` | FR-006 |
| PROP-002 | Monotonicity: every result for query `q` contains `q` (case-folded) in title or body — no false positives; and the result set never contains a prompt the input lacked. | Invariant | The AC-001 fixture plus metacharacter titles | FR-006 |
| PROP-003 | Filtering is read-only: the input array and its objects are unchanged after any call. | Conservation | Any input | FR-006 |
| PROP-004 | Ranking: every title-match index precedes every body-only-match index; within each group, input order is preserved (stable). | Order (monotonicity of rank) | AC-001 fixture reordered | FR-006 |
| Others | Round-trip, idempotence (filter(filter(x,q),q) = filter(x,q) — holds trivially by PROP-002, not separately tested), oracle, metamorphic: n/a — recorded here. | — | — | — |

Regex metacharacters in PROP-001 are the trap: the filter must treat the query as a literal string, not a pattern.

## 6. Budget declaration (standard ceilings)

| Metric | Declared | Ceiling | Status | Actual |
|---|---|---|---|---|
| Net source LOC | ~55 (`web/search.mjs` ~20, `web/index.html` delta ~35) | 300 | within | |
| Test LOC | ~80 | 200 | within | |
| New modules | 1 (`web/search.mjs`, shared by page and unit tests — the repo's first pure-logic module) | 2 | within | |
| Source files touched | 2 | 3 | within | |
| Test files touched | 1 (`tests/search.test.mjs`) | 3 | within | |
| New tables/columns/endpoints/UI surfaces/libraries/third-party | 0 (the search input extends the existing surface) | — | within | |
| User stories | 1 (U-001) | 1 | within | |
| New tests | 5 | 8 | within | |

## 7. Changes

**Data: none.** This slice must not touch the database, run any migration, or write any row. Unit tests are pure; the live-data drill happens at integration.

| Path | Action | Why |
|---|---|---|
| `web/search.mjs` | create | The filter/rank pure function, importable by both the page (browser ESM) and `node:test` |
| `web/index.html` | edit | Search input, wiring, empty state |
| `tests/search.test.mjs` | create | AC-001..AC-004 logic, PROP-001..004 |

## 8. Test plan

| Test ID | Level | Traces | Failure mode | Why not cheaper | Why not duplicate | Deletion criterion |
|---|---|---|---|---|---|---|
| T-U-001 | unit | AC-001, AC-002, PROP-002 | A prompt that matches is hidden, or one that does not match is shown | Pure function; unit is the cheapest level | First test of this function | FR-006 changes shape (tags) — then extended, not deleted |
| T-U-002 | unit | AC-001, PROP-004 | A body-only match ranks above a title match | Ordering is logic, not wiring | T-U-001 asserts membership, this asserts order | Same |
| T-U-003 | unit | AC-003 | A no-match query returns rows anyway | Same | Only no-match case | Same |
| T-U-004 | unit | AC-004, PROP-003 | Filtering mutates the list or loses rows on clear | Same | Only clear/identity case | Same |
| T-U-005 | unit | PROP-001 | A regex-metacharacter or non-ASCII query crashes or misfilters | Same; this is where literal-vs-pattern bugs live | Only adversarial-input case | Same |

DOM wiring (input event, empty state, prefill) is verified by the integration-phase browser drill, recorded in this spec's DoD — not by a unit test, and no browser dependency is added (0-library budget).

**Red first:** `web/search.mjs` starts as the GATE-RED R2 stub (`export function searchPrompts(prompts, query) { return prompts; }` — the minimum making failures assertions, not import errors). All five tests must be red on assertions before real logic is written. Ledger rows before tests.

## 9. Risks

RISK-001: client-side filter quietly degrades if the list fetch itself grows slow past ~300 prompts — accepted; ASM-001's monthly count is the watch, NFR-001's threshold test arrives with a seeded library.

## 10. Rollback

Revert the slice's commits; no data or schema to roll back.

## 11. Assumptions made during implementation

(Implementer fills.)

## 12. Definition of Done

- [ ] T-U-001..005 green; red output recorded first; one cycle logged if more were needed.
- [ ] Ledger rows predate tests; mutation-verified dates recorded (break the function per `rules/06-TESTS.md`: invert the case-fold, drop the rank sort, mutate the input — each must turn its test red).
- [ ] GATE-MINIMAL: no line undemanded by an AC/PROP; function ≤40 lines; `search.mjs` ≤250.
- [ ] Browser drill at integration: AC-001 and AC-003 exercised on the real page against live data, evidence recorded here.
- [ ] PRD FR-006 → `in-slice-001` at start, `done (partial: title+body; tags SL-006)` note at close — integrator applies with the change-log entry.
- [ ] Spec moved to `done/` with dates set.
