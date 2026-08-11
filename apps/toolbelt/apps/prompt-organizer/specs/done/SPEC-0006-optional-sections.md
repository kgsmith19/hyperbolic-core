---
title: Optional sections
spec_id: SPEC-0006-optional-sections
slice: SL-003
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07
owner: Kyle
traces: [FR-005]
---

# SPEC-0006: Optional sections

## 1. In one sentence

A body's `<!--OPTIONAL:id-->` blocks are detected, offered as checkboxes on the render panel, and either kept (content, fences stripped) or removed entirely at render time.

## 2. Why this, why now

FR-005, status `not-started`. SL-003 in the PRD's slice plan, depends on SL-002 (shipped). It is also the gate for SL-005 (Configurations), which cannot save "a list of included section ids" until section ids exist. SL-002's PROP-005 was written as an explicit forward-compat guarantee for this slice ("text outside `{{...}}`, including any `<!--OPTIONAL...-->` fence text SL-003 will later parse, passes through byte-for-byte") and T-U-011's deletion criterion reads "Never — the guarantee SL-003 will build on". This slice must therefore keep T-U-011 green, which constrains the parser: see AC-004.

**File-ceiling note.** PRD change log v0.1.5 flagged that `web/index.html` sits at NFR-009's 250-line ceiling exactly. Any UI addition breaches it. This slice therefore moves `buildRenderPanel` out to a new `web/panel.mjs` (the file's natural seam — it is the only DOM builder that is purely a function of a prompt's body). This is the mechanical cost of extending a file at its ceiling, declared in section 6, not scope widening.

## 3. Scope

**In:** a `SECTION_RE` matching a well-formed pair `<!--OPTIONAL:id-->…<!--/OPTIONAL:id-->` (CON-004 syntax, matching ids enforced by backreference); a pure `extractSections(body)` returning the ordered, deduplicated list of section ids; `render(body, values, includes)` gaining a third argument, applying sections *before* variable substitution; one checkbox per detected section on the render panel, checked by default; `buildRenderPanel` extracted to `web/panel.mjs` to stay under NFR-009.

**Out (three-plus per S4):** saved configurations (SL-005 — this slice supplies the section ids that FR-008 will persist, and nothing more); nested sections (PRD ASM-004 — the parser is deliberately flat and non-greedy, and a nested same-id block is undefined behavior, not a supported input); usage tracking (SL-007); a section-aware *preview* that re-renders as boxes are toggled (nothing in FR-005 asks for one; copy is the action); re-deriving the variable input list when a section is excluded (see section 11's assumption — inputs are built from the whole body, and a variable inside an excluded section is simply never demanded).

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-001 | A body with sections `a` and `b` | Rendered including only `a` | Output contains section `a`'s content, does not contain section `b`'s content, and contains no `<!--OPTIONAL` text | FR-005 |
| AC-002 | The same body | Rendered including both `a` and `b` | Both sections' content is present, in source order, and no fence text of either kind (`<!--OPTIONAL:` or `<!--/OPTIONAL:`) survives | FR-005 |
| AC-003 | A body whose section `a` appears twice and `b` once | `extractSections` is called | Returns exactly `["a", "b"]` — first-occurrence order, deduplicated | FR-005 |
| AC-004 | A body with an unterminated fence (`<!--OPTIONAL:x-->` with no closer) and one with mismatched ids (`<!--OPTIONAL:x-->…<!--/OPTIONAL:y-->`) | Rendered with any include list | Both pass through byte-for-byte; neither is treated as a section, and neither crashes (this is SL-002 T-U-011's exact fixture shape, which must stay green) | FR-005, PROP-005 |
| AC-005 | A body where `{{GONE}}` appears only inside section `b`, and `{{KEPT}}` outside it | Rendered including only `a`, with `KEPT` supplied and `GONE` absent | Render succeeds; `GONE` is not reported missing, because it is not present in the text being rendered | FR-005, FR-010 |
| AC-006 | A body containing no fences at all | Rendered | Output is identical to SL-002's behavior for that body — the third argument changes nothing when there are no sections | FR-005, FR-004 |

AC-001 is the PRD's literal FR-005 criterion. AC-004 is the failure case.

## 5. Properties (all nine walked)

| ID | Property | Kind | Domain | Traces |
|---|---|---|---|---|
| PROP-001 | Every render call ends in rendered text or a named missing list — never a crash — including on malformed, unterminated, mismatched, and empty-id fences. | Error totality | Bodies with 0, 1, many, and malformed fences | FR-005 |
| PROP-002 | Round-trip: `extractSections(body)` names exactly the ids whose inclusion changes the output — no id missed, no phantom id. | Round-trip | Bodies with 0–5 distinct ids | FR-005 |
| PROP-003 | Invariant: for a body whose fences are all well-formed, the output contains neither `<!--OPTIONAL:` nor `<!--/OPTIONAL:` for any include list. | Invariant | Same domain | FR-005 |
| PROP-004 | Idempotence: `render` never mutates its `body`, `values`, or `includes` arguments. | Idempotence | Any input | FR-005 |
| PROP-005 | Metamorphic: text outside token spans and outside well-formed fence spans passes byte-for-byte. Extends SL-002's PROP-005 rather than replacing it — the older guarantee still holds because a lone opening fence never forms a section. | Metamorphic | Fence-shaped text adjacent to tokens, non-ASCII | FR-005, FR-004 |
| PROP-006 | Order independence: the order of ids in `includes` does not affect the output. | Order independence | Same id set, different array orders | FR-005 |
| PROP-007 | Conservation: excluding a section removes exactly that block's content plus its two fences, and no other character. | Conservation | Multi-section bodies | FR-005 |
| PROP-008 | Monotonicity: if `includes₁ ⊂ includes₂`, then the output for `includes₁` is a subsequence of the output for `includes₂` — adding an id can only add content. | Monotonicity | Nested include lists over 3 sections | FR-005 |
| PROP-009 | Oracle: none beyond the literal ACs, which are their own expected values. | Oracle | n/a | — |

Text edge values per `rules/06-TESTS.md`: a body that is entirely one section; an empty section body (`<!--OPTIONAL:a--><!--/OPTIONAL:a-->`); adjacent sections with no text between them; a fence with an empty id (`<!--OPTIONAL:-->`, which the charset `[A-Za-z0-9_-]+` must not match); non-ASCII inside a section.

## 6. Budget declaration (standard ceilings)

| Metric | Declared | Ceiling | Status |
|---|---|---|---|
| Net source LOC | ~55 (`render.mjs` +24, `panel.mjs` +72 new, `index.html` −42) | 300 | within |
| Test LOC | ~120 (`tests/sections.test.mjs`) | 200 | within |
| New modules | 1 (`web/panel.mjs`) | 2 | within |
| Source files touched | 3 (`render.mjs`, `panel.mjs`, `index.html`) | 3 | at ceiling |
| Test files touched | 1 | 3 | within |
| New tables/columns/endpoints/libraries/third-party | 0 (client-side only; no migration) | — | within |
| User stories | 1 (U-001, via UC-003) | 1 | within |
| New tests | 7 (T-U-017..023) | 8 | within |

`web/index.html` ends this slice at ~208 lines, back under NFR-009's ceiling with headroom for SL-005.

## 7. Changes

**Data: none.** No migration. Section ids are derived from the body at read time (PRD DR-004: "Derived, not stored independently").

| Path | Action | Why |
|---|---|---|
| `web/render.mjs` | edit | `SECTION_RE`, `extractSections`, internal `applySections`, `render`'s third argument |
| `web/panel.mjs` | create | `buildRenderPanel` moved here, plus section checkboxes — keeps `index.html` under NFR-009 |
| `web/index.html` | edit | Delete `buildRenderPanel`, import it instead |
| `tests/sections.test.mjs` | create | AC-001..006, PROP-001..008 |

**Parser decisions, recorded because they are the whole slice:**

- Id charset is `[A-Za-z0-9_-]+`. The PRD's examples are lowercase (`a`, `b`, `lean`); permitting uppercase and `-`/`_` costs nothing and avoids surprising a body that writes `<!--OPTIONAL:Setup-->`. An empty id does not match, so `<!--OPTIONAL:-->` is inert text.
- The closing fence's id is a backreference (`\1`), so `<!--OPTIONAL:x-->…<!--/OPTIONAL:y-->` is not a section. This is what keeps AC-004 and T-U-011 green.
- Content matching is non-greedy (`[\s\S]*?`), so two sibling sections never merge into one match.
- **Sections are applied before variables.** Order matters: substituting first would demand a value for a variable that is about to be deleted, which contradicts FR-010's purpose. See AC-005.

## 8. Test plan

Ledger rows are written before the tests. Every test asserts against the literal fixtures above.

| Test ID | Level | Traces | Failure mode | Why not cheaper | Why not duplicate | Deletion criterion |
|---|---|---|---|---|---|---|
| T-U-017 | unit | AC-001, PROP-003, PROP-007 | An excluded section's content survives, an included one is lost, or fence text leaks into the output | Pure function; unit is cheapest | The literal FR-005 criterion; first test of exclusion | FR-005 changes shape |
| T-U-018 | unit | AC-002, PROP-003 | Including every section leaves fence comments behind, or reorders content | Pure function | T-U-017 excludes; this includes | Same |
| T-U-019 | unit | AC-003, PROP-002 | `extractSections` misses an id, invents one, duplicates a repeated id, or loses first-occurrence order | Pure function | Only extraction test | Same |
| T-U-020 | unit | AC-004, PROP-001, PROP-005 | A malformed fence (unterminated, mismatched ids, empty id) is treated as a section, is mangled, or crashes render | Pure function; this is where parser-boundary bugs live | Only adversarial-fence case; guards SL-002's T-U-011 contract from the other side | Never — the SL-002 forward-compat guarantee this slice inherited |
| T-U-021 | unit | AC-005 | A variable inside an excluded section blocks the render, or one in a kept section stops being demanded | Pure function | Only FR-005 × FR-010 interaction test | FR-005 or FR-010 changes |
| T-U-022 | unit | PROP-004, PROP-006, AC-006 | `render` mutates its arguments, output depends on `includes` order, or a fence-free body is altered by the new argument | Pure function | Only purity/order/regression case | Same |
| T-U-023 | unit | PROP-008 | Adding an id to `includes` removes content instead of adding it | Pure function; monotonicity is logic | Only monotonicity case; the first slice where PROP-008 is non-vacuous | Same |

**Red first:** `extractSections` starts as an R2 stub returning `[]`, and `render`'s third argument is accepted but ignored. Every test must be red on an assertion, not an import error.

Checkbox wiring (the panel's DOM) is verified by the integration-phase browser drill, recorded in the DoD — not unit-testable without a browser, and no new test dependency is added. This matches SPEC-0003's treatment of AC-003.

## 9. Risks

RISK-001: the backreference regex is the single point of failure for AC-004 and for SL-002's T-U-011. Covered directly by T-U-020 and by running the full existing suite, not by inspection.

RISK-002: a body could contain a well-formed section whose content itself contains a fence-shaped string. Non-greedy matching stops at the *first* matching closer, so the inner text is content, not structure. This is the flat-parser consequence of ASM-004 and is accepted, not fixed.

## 10. Rollback

Revert the slice's commits. No schema change exists to roll back. `web/panel.mjs` is deleted and `buildRenderPanel` returns to `index.html` at its prior 250 lines.

## 11. Assumptions made during implementation

**Two tests passed against the R2 stub, and that is inherent, not a defect.** T-U-020 (malformed fences stay literal) and T-U-022 (purity, include-order independence, fence-free body unchanged) were green before any parser existed. Both are *invariance* tests: their entire claim is that certain input is **not** transformed, and a stub that transforms nothing satisfies that vacuously. Five of seven were red on assertions as required; for these two the discipline's intent — a test must be able to fail — is served by mutation instead, so M4 and M6 were written specifically to break them (recorded in their ledger rows). Declared here rather than quietly accepted, matching SPEC-0003 §11's handling of T-U-009's targeted mutation.

**Sections resolve before variables.** Section 7 records the decision; the consequence is that FR-010's "a variable present in the body" is read as *present in the text being rendered*, not present in the stored body. A variable inside an excluded block is never demanded (AC-005, T-U-021, and confirmed live in the browser drill). The alternative — demanding a value for text about to be deleted — would make UC-003's lean flow strictly worse than not having sections at all.

**Variable inputs are built from the whole body, not the surviving text.** `buildRenderPanel` calls `extractVariables(prompt.body)` once, so an input for a variable that only appears inside an optional section stays on screen even when that section is unchecked. Its value is simply unused. Re-deriving the input list on every checkbox toggle would mean rebuilding DOM and discarding half-typed values; nothing in FR-005 asks for it, so it was not built (GATE-MINIMAL M1). The drill confirms the user-visible effect is correct: with the section unchecked, the stale `WHO` input is ignored and the copy succeeds.

**Checkboxes default to checked.** Nothing in FR-005 specifies a default. Checked was chosen because the full prompt is the unsurprising copy, and UC-003's "lean" form is the deliberate act of unchecking. This also makes SL-005's job clear: a saved configuration overrides the default, it does not establish one.

**`buildRenderPanel` moved to `web/panel.mjs`, and split in three.** The move was forced by NFR-009 (`index.html` was at 250/250 — PRD change log v0.1.5 flagged it). Once moved, adding the checkbox loop pushed the function itself to ~44 lines, over NFR-009's 40-line function budget, so `addVariableInputs` and `addSectionBoxes` were extracted. Each has exactly one caller, which normally trips "no abstraction with one caller" — declared here as a budget-forced mechanical split, not a speculative abstraction. `index.html` ends at 207 lines.

**GATE-MINIMAL M10 (deletion).** Purely additive plus one relocation. `render`'s third parameter defaults to `[]`, so every SL-002 call site behaves identically (AC-006, T-U-022) and no prior test needed changing — T-U-011, whose deletion criterion reads "Never — the guarantee SL-003 will build on", is green untouched. Nothing became dead, so nothing was deleted.

## 12. Definition of Done

- [x] T-U-017..023 green (7/7). Red recorded first: 5 of 7 failed on `ERR_ASSERTION` against the R2 stub; the other 2 are invariance tests covered by targeted mutations instead — section 11.
- [x] Ledger rows predate tests; all seven mutation-verified 2026-08-07 (M1..M7, real production-code mutations, each reverted).
- [x] Full suite green, 40/40 in 4.95s — in particular T-U-011, SL-002's forward-compat guarantee, green and untouched.
- [x] GATE-MINIMAL: every function ≤40 lines; `render.mjs` 69, `panel.mjs` 73, `index.html` 207 — all ≤250.
- [x] Browser drill, 2026-08-07 (Chromium 141 headless, driven over CDP with Node 22's built-in `WebSocket` — no library added; served from `python3 -m http.server 8812`, clipboard permissions granted, focus emulation on). Body `Hi {{NAME}}. <!--OPTIONAL:extra-->Extra for {{WHO}}.<!--/OPTIONAL:extra--> Bye.` produced 1 checkbox (`extra`, checked) and 2 text inputs (`NAME`, `WHO`). Section checked with `WHO` blank → `Missing: WHO`. Section **unchecked** with `WHO` still blank → `Copied!`, clipboard exactly `Hi Kyle.  Bye.` — AC-005 confirmed live. Section re-checked with `WHO` filled → clipboard exactly `Hi Kyle. Extra for the team. Bye.`, no fence text — AC-001/AC-002 confirmed live.
- [x] PRD FR-005 → `done`; change-log entry v0.1.6 — same commit as this file's move to `done/`.
- [x] DFD updated: F-8 now names the section checkboxes and records that excluding a section can only *remove* text from what F-4 already delivered; the section-ids-are-derived note points at DR-004.
- [x] Spec moved to `done/`, dates set.
