---
title: Variables and render
spec_id: SPEC-0003-variables-and-render
slice: SL-002
status: active
created: 2026-08-07
updated: 2026-08-07
completed:
owner: Kyle
traces: [FR-004, FR-007, FR-010]
---

# SPEC-0003: Variables and render

## 1. In one sentence

A body's `{{VAR}}` tokens are detected, prompted for on the page, substituted, and the fully rendered text is copied to the clipboard in one action — blocked with a named list of missing variables if any are unfilled.

## 2. Why this, why now

FR-004, FR-007, FR-010. The PRD calls SL-002 "the first useful day": at this point the tool beats retyping. Depends on SL-001 (list/search must exist to select a prompt to render); SL-000's storage and SL-001's list are both already shipped.

## 3. Scope

**In:** a pure `render(body, values)` function detecting `{{NAME}}` tokens (`[A-Z_][A-Z0-9_]*` inside `{{}}`, matching CON-004's syntax exactly) and substituting them; a pure `extractVariables(body)` returning the ordered, deduplicated list of variable names in a body; a per-prompt render panel on the page (one input per detected variable, populated as the user types); a copy button that renders, blocks with a named list of missing variables if any are empty, and otherwise writes to the clipboard and confirms within 1s (FR-007's threshold).

**Out (three-plus per S4):** optional sections (`<!--OPTIONAL:id-->`, SL-003 — a body may contain both syntaxes; this slice's `render` only handles `{{VAR}}` and passes section-fence text through untouched, verified by PROP-005); saved configurations (SL-005); usage tracking (SL-007); default values or any templating beyond literal substitution (PRD ASM-005 — the moment a prompt wants `{{VAR|default}}` this becomes a templating language, out of scope by design).

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-001 | Body `Repo is {{REPO}}.` | Rendered with `REPO=toolbelt` | Output is exactly `Repo is toolbelt.` | FR-004 |
| AC-002 | Body containing `{{A}}` and `{{B}}`, only `A` supplied | Render attempted | Rejected; the returned/displayed list of missing names is exactly `["B"]` | FR-010 |
| AC-003 | A prompt with all variables filled, open on the page | The copy control is activated | The clipboard holds the fully rendered text and the page shows a confirmation within 1 second | FR-007 |
| AC-004 | Body `{{REPO}} and {{REPO}} again`, `REPO=toolbelt` | Rendered | Both occurrences replaced: `toolbelt and toolbelt again`; `extractVariables` lists `REPO` once, not twice | FR-004 |
| AC-005 | Body with no `{{...}}` tokens | Rendered with an empty values object | Output equals the input body unchanged, no panel of inputs shown | FR-004 |

AC-002 is the failure case.

## 5. Properties (all nine walked)

| ID | Property | Kind | Domain | Traces |
|---|---|---|---|---|
| PROP-001 | Every render call ends in the rendered string or a named list of missing variables — never a crash, never a partial substitution. | Error totality | Bodies with 0, 1, and many tokens; values missing, present, empty-string | FR-004, FR-010 |
| PROP-002 | Round-trip: `extractVariables(body)` names exactly the set substituted by `render(body, valuesForAll)` — no token missed, no phantom substitution attempted. | Round-trip | Generated bodies with 0-10 distinct token names | FR-004 |
| PROP-003 | Invariant: the output contains no `{{` once every extracted variable has a value. | Invariant | Same domain | FR-004 |
| PROP-004 | Idempotence: `render` never mutates its `body` or `values` arguments. | Idempotence | Any input | FR-004 |
| PROP-005 | Metamorphic: text outside `{{...}}` (including any `<!--OPTIONAL...-->` fence text SL-003 will later parse) passes through byte-for-byte; only token spans change. | Metamorphic | Body with fence-like text adjacent to a token | FR-004, forward-compat with SL-003 |
| PROP-006 | Order independence: the key order of the `values` object does not affect the output. | Order independence | Same token set, values supplied in different key orders | FR-004 |
| PROP-007 | Conservation: the count of non-token characters is unchanged by rendering (only `{{NAME}}` spans are removed/replaced). | Conservation | Any input | FR-004 |
| PROP-008 | Monotonicity: none applies — no ranking, filtering, or pagination in this slice. | Monotonicity | n/a | — |
| PROP-009 | Oracle: none beyond the literal ACs, which are their own expected values. | Oracle | n/a | — |

Text edge values per `rules/06-TESTS.md`: empty body, a token adjacent to a `{{`/`}}`-like literal that is not a well-formed token (e.g. `{{` alone, `{{}}` empty name — CON-004's regex must not match either), a name with digits/underscore, non-ASCII in the surrounding text, a 100,000-character body (FR-001's own ceiling).

## 6. Budget declaration (standard ceilings)

| Metric | Declared | Ceiling | Status | Actual |
|---|---|---|---|---|
| Net source LOC | ~70 (`web/render.mjs` ~35, `web/index.html` delta ~35) | 300 | within | 80 (`web/render.mjs` 34 by `wc -l`; `web/index.html` +46/−0 by `git diff --numstat`) |
| Test LOC | ~140 | 200 | within | 132 (`wc -l tests/render.test.mjs`) |
| New modules | 1 (`web/render.mjs`) | 2 | within | 1 |
| Source files touched | 2 | 3 | within | 2 |
| Test files touched | 1 (`tests/render.test.mjs`) | 3 | within | 1 |
| New tables/columns/endpoints/libraries/third-party | 0 (client-side only; renders an already-fetched body) | — | within | 0 |
| User stories | 1 (U-001) | 1 | within | 1 |
| New tests | 7 | 8 | within | 8 (T-U-006..012 as planned, plus T-U-016 added to close a coverage hole found during mutation verification — section 11) |

## 7. Changes

**Data: none.** No migration, no database write beyond the existing save/list path.

| Path | Action | Why |
|---|---|---|
| `web/render.mjs` | create | `extractVariables`, `render` — pure functions, AC-001..005 |
| `web/index.html` | edit | Per-prompt render panel, copy control, missing-variable message |
| `tests/render.test.mjs` | create | AC-001..005, PROP-001..007 |

Clipboard API note: `navigator.clipboard.writeText` requires a secure context (`https:` or `localhost`) — satisfied by the drill setup (`http://localhost`) and by real deployment (`https://` per NFR-006/SR-02's Supabase-hosted-adjacent assumption); no polyfill or library is added.

## 8. Test plan

| Test ID | Level | Traces | Failure mode | Why not cheaper | Why not duplicate | Deletion criterion |
|---|---|---|---|---|---|---|
| T-U-006 | unit | AC-001, PROP-003 | A token is left unsubstituted or substituted with the wrong value | Pure function; unit is cheapest | First test of `render` | FR-004 changes shape |
| T-U-007 | unit | AC-002, PROP-001 | A render with missing variables proceeds instead of blocking, or names the wrong variable | Pure function | Only missing-variable case | Same |
| T-U-008 | unit | AC-004, PROP-002 | A repeated token is substituted only once, or extracted twice | Pure function | Only repeated-token case | Same |
| T-U-009 | unit | AC-005 | A body with no tokens is altered, or an empty panel is shown | Pure function | Only token-free case | Same |
| T-U-010 | unit | PROP-004 | `render` mutates its inputs | Pure function | Only mutation-check case | Same |
| T-U-011 | unit | PROP-005 | Text adjacent to a token (including a section-fence-shaped string) is altered | Pure function; this is the SL-003 forward-compat guard | Only adjacency case | Never — the guarantee SL-003 will build on |
| T-U-012 | unit | PROP-006 | Output depends on `values` key order | Pure function | Only order case | Same |

**Red first:** `web/render.mjs` starts as two R2 stubs (`extractVariables` returns `[]`; `render` returns `body` unchanged). All seven tests must be red on assertions before real logic exists. Ledger rows before tests.

Copy-to-clipboard wiring (AC-003) and the panel's live-input behavior are verified by the integration-phase browser drill, recorded in this spec's DoD — not unit-testable without a browser, and no new test dependency is added.

## 9. Risks

RISK-001: the token regex must reject `{{}}` (empty name) and unterminated `{{` without crashing — covered by PROP-001's domain, not a separate risk once T-U-007's adjacent cases pass.

## 10. Rollback

Revert the slice's commits; no schema change exists to roll back.

## 11. Assumptions made during implementation

**Missing-variable signal shape.** The spec left `render`'s exact return shape open (section 8's note). Chosen: a discriminated result object for both outcomes — `{ ok: true, text }` on success, `{ ok: false, missing: [...names] }` when any variable lacks a value — rather than throwing. Reasons: (1) it keeps `render` a total pure function with no control-flow-via-exception, matching PROP-001's "never a crash" framing literally; (2) both branches share one predictable shape (`{ ok, ... }`), so callers (the page, tests) never need `try/catch`; (3) it matches the sibling `search.mjs` module's plain-return style in this repo. `missing` is ordered by first occurrence in the body (same order `extractVariables` returns), not by `values`' key order.

**Empty-string vs. absent, and the UI bridge.** `render` itself treats only an absent/`undefined` key as missing — an explicit empty string is a supplied (empty) value, per the task's reading of AC-002's Given (only `A` supplied, not `A: ""`). Scope section 3 separately requires the page to "block ... if any are empty." These are reconciled in `web/index.html`'s `buildRenderPanel`: the copy handler omits a key from the `values` object entirely when its input is still empty, so an unfilled field becomes an absent key from `render`'s point of view and the existing missing-variable path fires. `render.mjs` itself stays a simple, literal implementation of PROP-001's contract; the UI is the one place that maps "empty input" to "absent key."

**Render panel gating.** Per AC-005 ("no panel of inputs shown" for a token-free body) and the task instruction, `buildRenderPanel` returns `null` — and neither inputs nor a copy control are rendered — when `extractVariables(body)` is empty. A token-free prompt currently has no copy-to-clipboard affordance at all; nothing in scope or the ACs asked for one, so none was built (GATE-MINIMAL M1).

**T-U-016 (coverage-hole test, added during mutation verification).** Mutation-verifying the seven planned tests (section 8) surfaced a real gap: reversing `extractVariables`' first-occurrence order (`push` → `unshift`) turned none of T-U-006..012 red, because the only multi-token fixture (T-U-008, AC-004) uses a single *repeated* name, and no fixture exercises 3+ *distinct* names' relative order. Per rules/06-TESTS.md's mutation-verification protocol ("if no mutation turns any test red, you have a hole exactly where you believed you had coverage"), this was closed with T-U-016 (ledger row added first, budget's "New tests" raised from 7 to 8 — still at, not over, the declared ceiling of 8) rather than recorded as an accepted gap, since section 3's scope explicitly calls extraction "ordered" — this is a real, spec-stated guarantee, not speculative coverage.

**T-U-009 required its own targeted mutation.** None of the six mutations named in the task's step 7 (a)-(f) happened to touch T-U-009 (AC-005, the empty-body case) — an empty body has no token span for a substitution- or order-bug to act on. A seventh, targeted mutation (falsy-string coalescing: `text: text || "empty"`) was added specifically to mutation-verify it; recorded in the ledger as its own entry.

**GATE-MINIMAL M10 (deletion).** This slice is purely additive — a new pure module plus a new, independently-gated section of the existing render list item. Nothing in the prior SL-000/SL-001/SL-004 surface became redundant or dead as a result, so nothing was deleted; `search.mjs`, `index.html`'s existing sign-in/save/search flow, and all prior tests are untouched.

**Browser drill not performed.** This slice's task did not include browser/manual-drill execution (no browser tooling was available in this environment). DoD's two drill items (AC-002 missing-variable block, AC-003 copy + clipboard content, both "exercised on the real page, evidence recorded") are left unchecked below and flagged for the integrator, per section 8's own note that AC-003's wiring and the panel's live-input behavior are integration-drill-verified, not unit-testable.

## 12. Definition of Done

- [x] T-U-006..012 green; red output recorded first. (Also T-U-016, added mid-slice to close a coverage hole — section 11.)
- [x] Ledger rows predate tests; mutation-verified dates recorded.
- [x] GATE-MINIMAL: function ≤40 lines each, file ≤250.
- [ ] Browser drill: AC-002 (missing-variable block) and AC-003 (copy + clipboard content) exercised on the real page, evidence recorded. **Not performed this slice — no browser tooling in this environment; deferred to integrator (section 11).**
- [ ] PRD FR-004, FR-007, FR-010 → `done`; change-log entry — integrator applies.
- [ ] DFD updated: render is a client-side-only transform, no new flow to the database. — integrator applies.
- [ ] Spec moved to `done/`, dates set. — integrator applies.
