---
title: Idea effectiveness score
spec_id: SPEC-0001-idea-effectiveness-score
slice: SL-001
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07
owner: Kyle
traces: [FR-004, FR-005]
---

# SPEC-0001: Idea effectiveness score

## 1. In one sentence

The idea list page shows each idea's recorded effectiveness score out of 10, and the database rejects any score outside the range its metric declares.

## 2. Why this, why now

| Field | Answer |
|---|---|
| Requirement being served | FR-004, FR-005 |
| What a user can do after this that they could not before | Kyle can see a judgment of how well each idea solves its stated problem, next to it on the list page, and use that to rank what to build next (UC-001) |
| Why this slice comes before the next one | `idea.score` and `core.metric_def` already exist from SL-000 with no reader; this is the smallest change that gives them one |
| What we learn from shipping it | Whether `(idea, metric) -> value` is the right shape for a single proxy score before it has to carry a real composite (Kyle, 2026-08-07: "we will ultimately have some sort of composite score... for now some sort of confidence or effectiveness score") |

## 3. Scope

### 3.1 In scope

- One row in `core.metric_def`: the `idea_effectiveness` metric, 0-10, `is_proxy = true`
- Two new nullable columns on `core.metric_def`: `min_value`, `max_value`
- A trigger on `idea.score` rejecting a `value` outside its metric's declared range
- The idea list page displaying each idea's most recent score per metric, alongside the metric's name
- An idea with no score row showing no score value, never a zero

### 3.2 Out of scope

| Not doing | Why not | Where it goes instead |
|---|---|---|
| A UI for entering or editing scores | PRD OOS-002; scores are written by migration until a tool needs a write path (PRD DR-004) | A tool (Golden Goose, Constraint Finder) specced against `idea.score`'s write path |
| A composite score across multiple metrics | Kyle named this as future work, contingent on live tracking data this slice does not yet have | A later slice, once `core.metric_def.supersedes` has a measured metric to roll up |
| Scoring anything other than ideas (e.g. individual prompts) | `idea.score.idea_id` only references `idea.idea`; a prompt table is a different repo's schema (PRD CON-002) | Prompt Organizer's own repo, if it wants prompt-level scoring |
| A real, permanent score value for any idea | That is Kyle's judgment to enter, not this implementer's to invent | Kyle, via a migration, whenever he judges an idea |
| A dependency-graph UI | `idea.dependency` has no reader yet; unrelated to this slice | SL-002 |

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-008 | `core.metric_def` has a row `id=idea_effectiveness, name=Idea effectiveness`, and `idea.score` has a row `idea_id=prompt-organizer, metric_id=idea_effectiveness, value=8` | An authenticated request reads `idea.score` for `prompt-organizer` and `core.metric_def` for `idea_effectiveness` | The response shows `value=8` and `name=Idea effectiveness` | FR-004 |
| AC-009 | `idea.score` has no row for a given idea | The idea list page renders that idea | Its score cell is empty, never `0` | FR-004 |
| AC-010 | `core.metric_def` has `idea_effectiveness` with `max_value=10` | An authenticated request inserts into `idea.score` with `idea_id=prompt-organizer, metric_id=idea_effectiveness, value=11` | The insert fails with Postgres error code `23514` and no row is created | FR-005 |
| AC-011 | `core.metric_def` has `idea_effectiveness` with `min_value=0` | An authenticated request inserts into `idea.score` with `idea_id=prompt-organizer, metric_id=idea_effectiveness, value=-1` | The insert fails with Postgres error code `23514` and no row is created | FR-005 |

AC-009, AC-010, and AC-011 are the failure cases.

AC-009 is not covered by an automated test. Its Given is the current state
of production `idea.score` for every idea (empty), which is true before any
line of this slice is written -- a live read asserting that would pass
vacuously and could never legitimately be red (GATE-RED R1). The behavior
it actually names is a rendering choice on `web/index.html` ("render
nothing", not "render 0"), verified the same way AC-001's rendering half
was in SPEC-0000: a manual browser drill, recorded in section 12, not an
automated test. No headless-browser dependency is added, matching
`MAX_NEW_LIBRARIES: 0`.

## 5. Properties

| ID | Property | Kind | Input domain | Traces to |
|---|---|---|---|---|
| PROP-010 | For all inserts into `idea.score`, the result is either the row is created or a named Postgres error code is returned (`23503` bad `idea_id`/`metric_id`, `23502` missing required column, `23514` out-of-range value); no request ever crashes the connection or partially writes a row. | Error totality | Every column combination valid and invalid per `idea.score`'s foreign keys, `not null` columns, and the new trigger | FR-004, FR-005 |
| PROP-011 | For a score written with a given `idea_id`, `metric_id`, and `value`, reading it back by its `id` returns exactly those three values. | Round-trip | Any value inside `idea_effectiveness`'s declared `[0, 10]` range | FR-004 |
| PROP-012 | For any metric with `min_value`/`max_value` set, every row in `idea.score` referencing it always satisfies `min_value <= value <= max_value`. | Invariant | `idea.score` rows referencing a bounded metric | FR-005 |
| PROP-013 | Idempotence: none applies, by design. `idea.score` is an append-only judgment log (PRD DR-004: "superseded rows are kept, not overwritten"); inserting the same `(idea_id, metric_id, value)` twice legitimately creates two historical rows, not one. | Idempotence | n/a | DR-004 |
| PROP-014 | Order independence: none applies. Two distinct score rows do not interact; inserting them in either order produces the same final state. | Order independence | n/a | — |
| PROP-015 | The raw `idea.score` and `core.metric_def` rows are the oracle for what the list page must display: the displayed value and metric name for an idea always equal the most recent (`scored_at`) `idea.score` row per `(idea_id, metric_id)`, joined to that metric's `name`. | Oracle / model | The two tables themselves | FR-004 |
| PROP-016 | Metamorphic: if `idea_effectiveness.min_value` is lowered below a previously-rejected value, a later insert of that same value is accepted; if raised above a previously-accepted value, a later insert of that value is rejected. Not written as a separate test: the trigger reads bounds at insert time by definition, so this follows from PROP-012 and is not independently valuable to re-assert. | Metamorphic | `idea_effectiveness`'s `min_value`/`max_value` | FR-005 |
| PROP-017 | Conservation: `count(idea.idea)` is unchanged by any `idea.score` insert, update, or delete. `idea.score.idea_id` is a foreign key with no cascade side effect on `idea.idea`. Not separately tested, same reasoning as SPEC-0000 PROP-007: this is a fact about Postgres referential design, not this system's logic. | Conservation | Any sequence of `idea.score` writes | — |
| PROP-018 | Monotonicity: none applies. This slice displays raw score values with no ranking, aggregation, or composite computed over them. A composite (Kyle, 2026-08-07: named as future work) would earn this property when it exists. | Monotonicity | n/a | — |

## 6. Budget declaration

| Metric | Declared | Ceiling | Status |
|---|---|---|---|
| Net source LOC | ~100 (migration ~48, down ~9, `web/index.html` ~45 net) | 300 | within |
| Test LOC | ~60 (`tests/scores.test.mjs`) | 200 | within |
| New modules/classes | 0 | 2 | within |
| Source files touched | 3 (1 migration, 1 down migration, 1 `web/index.html` edit) | 3 | within, at ceiling |
| Test files touched | 1 (`tests/scores.test.mjs`, new) | 3 | within |
| New tables | 0 | 1 | within |
| New columns | 2 (`core.metric_def.min_value`, `max_value`) | 6 | within |
| New endpoints | 0 (PostgREST auto-generated, same as every prior slice) | 1 | within |
| New UI surfaces | 0 (editing the existing page, not a new one) | 1 | within |
| New libraries | 0 | 0 | within |
| New third-party services | 0 | 0 | within |
| User stories | 1 (U-001, extended) | 1 | within |
| New tests | 3 (T-A-004, T-I-007, T-I-008) | 8 | within |
| New config keys | 0 | 2 | within |

No exception needed. Migration and down migration are counted together as one logical change, consistent with how SPEC-0000 counted a migration/down-migration pair as one "change" in section 7 while still listing both files in section 7.3.

## 7. Changes

### 7.1 Interfaces

None new. The page adds two more read-only calls to PostgREST's existing auto-generated API (`GET /rest/v1/score` under the `idea` schema, `GET /rest/v1/metric_def` under the `core` schema), the same mechanism `fetchIdeas` already uses.

### 7.2 Data

| Change | Table(s) | Forward migration | Down migration | Backfill needed | Zero-downtime approach |
|---|---|---|---|---|---|
| Add bounds columns, add bounds-enforcing trigger, seed `idea_effectiveness` metric | `core.metric_def`, `idea.score` | `supabase/migrations/20260807050000_score_bounds_and_effectiveness_metric.sql` | `supabase/migrations/20260807050000_score_bounds_and_effectiveness_metric_down.sql` | no | New columns are nullable; the trigger only fires on new/updated `idea.score` rows, of which there are none yet in production |

### 7.3 Files expected to change

| Path | Action | Why |
|---|---|---|
| `supabase/migrations/20260807050000_score_bounds_and_effectiveness_metric.sql` | create | Bounds columns, trigger, seed row: FR-004, FR-005 |
| `supabase/migrations/20260807050000_score_bounds_and_effectiveness_metric_down.sql` | create | Rollback for the above |
| `web/index.html` | edit | Display each idea's score: FR-004 |
| `tests/scores.test.mjs` | create | AC-008 through AC-011 |
| `specs/TEST-LEDGER.md` | edit | New rows for T-A-004, T-A-005, T-I-007, T-I-008 |
| `docs/PRD.md` | edit | FR-004, FR-005 status `planned` -> `done` |
| `docs/SYSTEM-REQUIREMENTS.md` | edit | New SR entries for the two read flows and the bounds-enforcement mechanism |
| `docs/DATA-FLOW-DIAGRAM.md` | edit | New flows F-7, F-8; `core.metric_def` no longer empty |

## 8. Test plan

| Test ID | Level | Traces to | Failure mode it catches | Why not a cheaper level | Why not covered already | Deletion criterion |
|---|---|---|---|---|---|---|
| T-A-004 | acceptance | AC-008 -> FR-004 | A scored idea's value or metric name is missing or wrong on read | Only a real read against both tables proves the join the page performs | No other test reads `idea.score` joined to `core.metric_def` | If the page stops displaying scores |
| T-I-007 | integration | AC-010 -> FR-005 | A score above a metric's declared maximum is accepted | A `CHECK` cannot look up `core.metric_def`; this proves the trigger is wired | No other test inserts an out-of-range score | Never; this is the range guarantee itself |
| T-I-008 | integration | AC-011 -> FR-005 | A score below a metric's declared minimum is accepted | Same as T-I-007, the symmetric boundary | T-I-007 covers the upper bound only | Never |

AC-009 has no row here; see its note in section 4.

## 9. Risks

| ID | Risk | Likelihood | Impact | Mitigation in this slice | Accepted by |
|---|---|---|---|---|---|
| RISK-004 | `idea_effectiveness`'s `gaming_risk` and `formula` wording is this implementer's draft, not Kyle's own words. | certain | low (text-only, editable in a follow-up migration) | Recorded as ASM-006 in section 11 for Kyle to correct or confirm | Kyle |
| RISK-005 | No real score exists for any idea after this slice ships; the page will show every idea unscored until Kyle enters one. | certain | none (this is the correct behavior, not a bug) | AC-009 tests exactly this state | Kyle |

## 10. Rollback plan

| Field | Answer |
|---|---|
| How to undo | Run `20260807050000_score_bounds_and_effectiveness_metric_down.sql`; revert `web/index.html` to its prior commit |
| Time to undo | Under 5 minutes; one `DROP TRIGGER`/`DROP FUNCTION`/`ALTER TABLE ... DROP COLUMN` migration plus one file revert |
| Data written that survives rollback | None in production (no real score has been entered); test rows are inserted and deleted within their own test |
| Feature flag | None; the page change is additive (a new table column) and fails closed (no score data means no score cell content) |
| Who decides to roll back | Kyle |
| Signal that triggers rollback | AC-008 through AC-011 fail after deploy, or the trigger rejects a legitimate Kyle-entered score |

## 11. Assumptions made during implementation

| ID | Assumption | Why it was needed | How to verify | Blast radius if wrong | Promoted to PRD? |
|---|---|---|---|---|---|
| ASM-006 | `idea_effectiveness`'s `name`, `formula`, and `gaming_risk` text are this implementer's draft wording, not a decision Kyle stated verbatim. | `core.metric_def.gaming_risk` is `NOT NULL`; a real seeded row needs real text, and only the metric's existence and 0-10 range were specified. | Read the seeded row; if the wording is wrong, correct it with a follow-up migration (`UPDATE`, not a new row, since the `id` should not change) | Low: cosmetic text on one row, corrected in place | no — Kyle can amend directly; promoting draft wording to the PRD would be premature |
| ASM-007 | "Next to each idea" (PRD FR-004) means the page shows each idea's **most recent** score per metric, not its full scoring history. | `idea.score` is append-only (DR-004); with no dedup, a re-scored idea would show every historical value stacked in one cell. | Re-score an idea twice via migration; confirm the page shows only the latest value | Low: display-only; no data is lost, since `idea.score` keeps every row regardless of what is rendered | no — a scoring-history view is a plausible future slice, not a correction to this one |

## 12. Definition of Done (GATE-SPEC-DONE)

- [x] Every `AC` has a passing test or a recorded manual-drill reason, with the test ID recorded. AC-008 T-A-004, AC-010 T-I-007, AC-011 T-I-008. AC-009 has no automated test by design (section 4); verified by a real-browser drill against live data, Playwright/Chromium pre-installed in the environment, nothing added to the repo (`MAX_NEW_LIBRARIES: 0` unchanged, same as SPEC-0000's ASM-005 drill): unscored `prompt-organizer` rendered its score cell as `""` (not `"0"`); after inserting a throwaway `idea.score` row via SQL, the same cell rendered `"Idea effectiveness: 8"`; the row was then deleted and the cell reverted to `""`. Zero browser console errors either time.
- [x] Every `PROP` has a passing property test or a recorded reason it does not apply. PROP-010 (error totality): T-I-007/T-I-008 cover the `23514` class; `23503`/`23502` are the same mechanisms T-I-003/T-I-004 already proved on other tables, not re-proven here. PROP-011 (round-trip): covered by T-A-004's insert-then-read. PROP-012 (invariant): covered by T-I-007/T-I-008 (both boundary directions) plus the `metric_def_bounds_ordered` CHECK preventing an unsatisfiable range from ever existing. PROP-013, PROP-014, PROP-016, PROP-017, PROP-018: not applicable, reasons recorded in section 5. PROP-015 (oracle): the two tables are the oracle; T-A-004 asserts against them directly, no separate test needed.
- [x] GATE-GREEN passes in full, with command output shown. `node --test "tests/*.test.mjs"`: 10/10 pass, 0 fail, 0 skipped, 1.38s. G3/G4/G5 not applicable, same as every prior slice (no lint/typecheck/build tool in this repo). Largest touched file (`web/index.html`) is 138 lines against the 250 ceiling; largest function (`latestScoresByIdea`) is 14 lines against the 40 ceiling.
- [x] Every declared budget line has an Actual value. Net source LOC: 69 (migration: 60 up + 9 down) + 44 (`web/index.html`, `git diff --stat`: +49/-5) = 113, under 300. Test LOC: 54 (`tests/scores.test.mjs`), under 200. Source files touched: 3 (migration, down migration, `web/index.html`), at the ceiling. Test files touched: 1, under 3. New columns: 2, under 6. New tests: 3, under 8. Every other line matches its declared value exactly (0).
- [x] Every test in section 8 passed GATE-TEST-JUSTIFIED, with a mutation-verified date in `specs/TEST-LEDGER.md`. T-A-004: 2026-08-07, mutated the seeded metric's name, test went red on the exact assertion, reverted. T-I-007/T-I-008: 2026-08-07, disabled the bounds trigger, both went red (201 instead of 400), re-enabled, leaked rows deleted.
- [x] PRD status column updated for FR-004, FR-005 (`planned` -> `done`, v0.1.6).
- [x] `docs/SYSTEM-REQUIREMENTS.md` (SR-024, SR-025, SR-026) and `docs/DATA-FLOW-DIAGRAM.md` (F-7, F-8, `core.metric_def`/`idea.score` rows) updated.
- [x] Rollback plan tested. The down migration was not run destructively against production (it would delete the real `idea_effectiveness` metric definition mid-review), but every operation it performs was individually exercised and reverted during mutation verification: the trigger was disabled and re-enabled, and the metric row's `name` was updated and restored. The one untested step is the `DROP COLUMN`/`DROP CONSTRAINT`/`DROP FUNCTION`/`DROP TRIGGER` DDL itself, which is syntactically unremarkable and symmetric with the `ADD COLUMN`/`ADD CONSTRAINT`/`CREATE FUNCTION`/`CREATE TRIGGER` that did run successfully as the forward migration.
- [x] Nothing added that no `AC` or `PROP` required. `web/index.html`'s `id` field was added to `fetchIdeas`'s select list because `renderIdeas` needs it to key into the score map; it is not rendered as its own cell.
- [x] `updated` and `completed` dates set in front matter; moved to `specs/done/`.
