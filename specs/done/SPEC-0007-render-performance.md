---
title: Render performance
spec_id: SPEC-0007-render-performance
slice: SL-010
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07
owner: Kyle
traces: [NFR-002, ASM-003, ASM-004]
---

# SPEC-0007: Render performance

## 1. In one sentence

`render` completes within NFR-002's 100 ms budget for **any** body the schema permits — including a pathological one — which today it does not, because SL-003's section parser is quadratic.

## 2. Why this, why now

NFR-002 is `not-started`. Measuring it before writing the test — the honest order — found that it **currently fails**, so this is a defect slice, not a documentation slice.

Measured on the session container, `render(body, {}, [])` where `body` is `"<!--OPTIONAL:a-->".repeat(5882)` (99,994 characters, inside FR-001's `check (char_length(body) between 1 and 100000)`):

| Body | p95 | NFR-002 (100 ms) |
|---|---|---|
| Realistic 100,000 chars (variables + well-formed sections) | 2.0 ms | pass, 50× headroom |
| 99,994 chars of unterminated `<!--OPTIONAL:a-->` fences | **210 ms** | **FAIL, 2.1× over** |

Scaling of the failing case, each doubling quadrupling the time — the signature of O(n²):

| Opening fences | Chars | Time |
|---|---|---|
| 1,250 | 21,259 | 1.3 ms |
| 2,500 | 42,509 | 5.2 ms |
| 5,000 | 85,009 | 24.0 ms |
| 10,000 | 170,009 | 101.9 ms |

**Root cause.** `SECTION_RE` is `/<!--OPTIONAL:([A-Za-z0-9_-]+)-->([\s\S]*?)<!--\/OPTIONAL:\1-->/g`. For every opening fence the engine expands `[\s\S]*?` toward the end of the string hunting a closing fence that never arrives, fails, and restarts at the next opening fence. Each of the n attempts scans O(n) characters, so the whole pass is O(n²). A body with no closing fences at all is the worst case, and it is a body FR-001 explicitly allows.

**A recorded measurement error.** A first, single-shot benchmark of this same body reported 34.7 ms and I wrote it up as passing. It did not reproduce: ten independent calls in a clean process give 207–215 ms. The 34.7 ms sample is discarded as measurement error. This spec's numbers are the reproducible ones; the retraction is recorded here rather than quietly corrected.

## 3. Scope

**In:** replacing the backtracking `SECTION_RE` with a single-pass, non-backtracking fence scanner, preserving SPEC-0006's AC-001..006 behavior exactly; a benchmark test pinning NFR-002's threshold for both a realistic and the pathological body.

**Out (three-plus per S4):** optimizing variable substitution (`TOKEN_RE` is a simple alternation-free pattern with no nested quantifier — it cannot backtrack quadratically, and measures 2.0 ms at the ceiling); NFR-001's search performance (a different requirement, needs a seeded database, SL-001's concern); changing FR-001's 100,000-character bound (that bound is the requirement, not the problem); supporting nested sections (PRD ASM-004 still says undefined — this slice must merely not *corrupt* output when they occur, see AC-005).

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-001 | A realistic 100,000-character body containing variables and well-formed sections | Rendered, p95 over ≥20 warm iterations | Completes in under 100 ms | NFR-002 |
| AC-002 | A 99,994-character body consisting only of unterminated `<!--OPTIONAL:a-->` fences | Rendered, p95 over ≥20 warm iterations | Completes in under 100 ms, and the output equals the input byte-for-byte | NFR-002, SPEC-0006 AC-004 |
| AC-003 | The same pathological body at 1×, 2×, and 4× a base size | Each rendered | Time grows at most linearly within a generous tolerance — doubling the input does not quadruple the time | NFR-002 |
| AC-004 | Every SPEC-0006 fixture (AC-001..006 there: exclusion, inclusion, extraction order, malformed fences, the variable-in-excluded-section case, fence-free bodies) | Rendered through the new scanner | Byte-identical results to the current implementation — the rewrite is behavior-preserving | FR-005 |
| AC-005 | A body with interleaved sections (`<!--OPTIONAL:a-->…<!--OPTIONAL:b-->…<!--/OPTIONAL:a-->…<!--/OPTIONAL:b-->`) | Rendered | Output matches the old regex's left-to-right, non-overlapping behavior: the first complete pair is applied and the overlapping one is left as literal text. Undefined by ASM-004, but never corrupt | FR-005, ASM-004 |

AC-002 is the failure case and the one that is red today.

## 5. Properties (all nine walked)

| ID | Property | Kind | Domain | Traces |
|---|---|---|---|---|
| PROP-001 | Error totality: no body within FR-001's bounds causes a crash, a hang, or superlinear blowup. | Error totality | 0, 1, many, and all-malformed fences up to 100,000 chars | NFR-002 |
| PROP-002 | Round-trip: the new scanner's section id list equals the old regex's for every SPEC-0006 fixture. | Round-trip | All SPEC-0006 fixtures | FR-005 |
| PROP-003 | Invariant: sections applied are non-overlapping and left-to-right, as the old non-greedy regex produced. | Invariant | Interleaved and repeated ids | FR-005 |
| PROP-004 | Idempotence: `render` still mutates none of its arguments. | Idempotence | Any input | FR-005 |
| PROP-005 | Metamorphic: text outside token and well-formed fence spans still passes byte-for-byte. | Metamorphic | SL-002's T-U-011 fixture | FR-004, FR-005 |
| PROP-006 | Order independence: `includes` order still irrelevant. | Order independence | Reordered include lists | FR-005 |
| PROP-007 | Conservation: complexity is O(n) in body length — total characters scanned is bounded by a constant multiple of the body. | Conservation | Doubling sizes | NFR-002 |
| PROP-008 | Monotonicity: render time grows monotonically and at most linearly with body size. | Monotonicity | 1×, 2×, 4× | NFR-002 |
| PROP-009 | Oracle: the current implementation is the oracle for behavior (AC-004) — the rewrite must agree with it on every existing fixture. | Oracle | All SPEC-0006 fixtures | FR-005 |

## 6. Budget declaration (standard ceilings)

| Metric | Declared | Ceiling | Status |
|---|---|---|---|
| Net source LOC | ~30 (`render.mjs`: replace `SECTION_RE` + `applySections` + `extractSections` with a shared span scanner) | 300 | within |
| Test LOC | ~70 (`tests/performance.test.mjs`) | 200 | within |
| New modules | 0 | 2 | within |
| Source files touched | 1 (`web/render.mjs`) | 3 | within |
| Test files touched | 1 | 3 | within |
| New tables/columns/endpoints/libraries/third-party | 0 | — | within |
| User stories | 1 (U-001 — a render that takes 210 ms is a render the user waits on) | 1 | within |
| New tests | 3 (T-U-024..026) | 8 | within |

## 7. Changes

**Data: none.** No migration.

| Path | Action | Why |
|---|---|---|
| `web/render.mjs` | edit | Replace the backtracking pair-regex with a single-pass fence scanner |
| `tests/performance.test.mjs` | create | AC-001..003, the NFR-002 gate |

**Design.** One non-backtracking pattern matches *either* fence:

```
const FENCE_RE = /<!--(\/?)OPTIONAL:([A-Za-z0-9_-]+)-->/g;
```

A single `matchAll` pass builds the list of complete pairs, keeping a map of unclosed opening fences. **First open wins** (an id already open is not overwritten), which reproduces the old non-greedy regex's pairing. A closing fence with no matching open is ignored, so mismatched ids and stray closers stay literal text. Overlapping pairs are dropped left-to-right, reproducing the old regex's non-overlapping scan (AC-005). Each character is visited a constant number of times, so the pass is O(n).

`extractSections` and `applySections` both read this one span list, so they cannot disagree about what a section is.

**Consequence for PR #2's dedup.** `firstOccurrenceIds(body, pattern)` was introduced last pass to collapse `extractVariables` and `extractSections`, which were then byte-identical. `extractSections` now derives ids from the span scanner instead of a raw pattern, so the helper drops to a single caller and is inlined back into `extractVariables`. That is not a reversal of the earlier call — the dedup was correct for the code as it stood; this slice changes the code so the shared shape no longer exists.

## 8. Test plan

| Test ID | Level | Traces | Failure mode | Why not cheaper | Why not duplicate | Deletion criterion |
|---|---|---|---|---|---|---|
| T-U-024 | unit | AC-001 | A realistic maximum-size body becomes slow enough for the user to feel it | Timing is the only way to observe timing; no static check proves a wall-clock budget | Only realistic-body benchmark | NFR-002's threshold changes |
| T-U-025 | unit | AC-002, PROP-001 | A body the schema permits takes 2× the NFR-002 budget — the defect this slice exists to fix | Same | Only pathological-body benchmark | Same |
| T-U-026 | unit | AC-003, PROP-007, PROP-008 | Section parsing regresses to superlinear again, which a fixed-threshold test on fast hardware would miss | A ratio is machine-independent in a way a wall-clock threshold is not, so it catches the regression even where absolute times are small | T-U-024/025 pin absolute budget; this pins the growth curve | Section parsing is removed |

AC-004 (behavior preservation) and AC-005 (interleaving) need no new test: the existing SPEC-0006 suite (T-U-017..023) plus SL-002's T-U-006..012/016 **are** the oracle, and all 40 must stay green through the rewrite. AC-005's interleaved case is the one shape no existing fixture covers; it is asserted inside T-U-026 rather than as an eighth test, since it is a correctness rider on the same rewrite.

**Flakiness.** T-U-024 and T-U-025 assert a wall-clock threshold, which is machine-dependent. Mitigations: warm-up iterations before measuring; p95 over ≥20 iterations rather than a single shot (the discipline whose absence produced the retracted 34.7 ms figure); and, after the fix, headroom of roughly 50× rather than 2×. T-U-026's ratio assertion carries a generous tolerance so ordinary scheduling noise cannot redden it. If these ever do flake, the ledger rows say what to conclude.

## 9. Risks

RISK-001: the rewrite is behavior-preserving in intent, and the whole SPEC-0006 suite is the guard. Any disagreement is a bug in the rewrite, not a spec change.

RISK-002: `TOKEN_RE` is untouched. It has no nested quantifier and cannot backtrack quadratically; measured 2.0 ms at the ceiling. Recorded so a later reader does not assume both patterns were audited to the same depth — only the section pattern was rewritten.

## 10. Rollback

Revert the slice's commit. No schema change.

## 11. Assumptions made during implementation

**V8 tiers up the section regex, and that is what produced the retracted 34.7 ms.** Measured on the pathological body with the old parser: **164.8 ms** in a fresh process, **29.7 ms** in a process that had already rendered a body containing *matching* sections. A 5.5× swing from JIT state alone. Every earlier confusing number is explained by it — the original 34.7 ms ran after other renders had warmed the pattern; the 210 ms standalone did not. It also means a wall-clock benchmark on this body is **order-dependent**: in-suite, T-U-024 runs first and warms the regex, so T-U-025 would have passed against the unfixed parser and hidden the defect entirely. Two consequences, both acted on: T-U-025's mutation check is run in isolation (recorded in its ledger row), and after the fix the cold-JIT figure is **0.98 ms**, ~100× under budget, so the order-dependence stops mattering rather than being merely worked around.

**T-U-026 had to move above the timer's noise floor.** Written first at 1,000 vs 4,000 fences, it went red in the full suite while passing alone. The cause was not flakiness in the usual sense: with the linear parser those inputs render in ~0.6 ms and ~0.36 ms — the 4×-larger input measured *faster* — so the ratio was measuring jitter. Raised to 15,000 vs 60,000 fences (1.28 ms → 4.41 ms), and an explicit guard now fails the test if the base measurement drops back under 0.5 ms, so a future size reduction fails loudly instead of turning the assertion vacuous. Those sizes exceed FR-001's 100,000-character storage bound deliberately: this test measures the growth curve, not a storable body, and the absolute budget is pinned by T-U-024/025 at in-bounds sizes.

**Behavior preservation was verified, not assumed.** All 40 pre-existing tests pass unchanged through the rewrite (AC-004's oracle), including SL-002's T-U-011 and SPEC-0006's T-U-017..023. The one shape no existing fixture covered — interleaved pairs — is asserted inside T-U-026: `<!--OPTIONAL:a-->A<!--OPTIONAL:b-->B<!--/OPTIONAL:a-->C<!--/OPTIONAL:b-->` yields `A<!--OPTIONAL:b-->BC<!--/OPTIONAL:b-->` including `a`, matching the old regex's left-to-right non-overlapping scan exactly. ASM-004 still calls nesting undefined; this slice only guarantees it is not *corrupt*.

**PR #2's `firstOccurrenceIds` was inlined back.** `extractSections` now reads the span scanner rather than a raw pattern, so the helper dropped to one caller and would have violated "no abstraction with one caller". Inlined into `extractVariables`. The earlier dedup was correct for the code as it stood; this slice changed the code so the shared shape no longer exists — recorded so the history does not read as a reversal.

**`TOKEN_RE` was not audited to the same depth.** It has no nested quantifier and cannot backtrack quadratically, and the realistic body measures 2.0 ms, so it was left alone (RISK-002). Only the section pattern was rewritten.

**A rate limit, not a defect.** Running the full suite five times inside a minute makes the integration tests fail with `login failed …: 429` from Supabase auth. That is a limit on the shared test account. The three new benchmarks ran green 8/8 in consecutive unit-only runs, which is the stability evidence that matters for them.

## 12. Definition of Done

- [x] T-U-024..026 written after their ledger rows. T-U-026 red first on its assertion (`4x the input grew time 14.8x`). T-U-025 red against the pre-fix parser at p95 210.9 ms — in isolation, since in-suite JIT warming from T-U-024 masks it (section 11).
- [x] All 40 existing tests green through the rewrite (AC-004, the oracle) — 43/43 total.
- [x] Mutation-verified: M1 (real pre-fix parser) reddens T-U-025 (210.9 ms) and T-U-026 (15.0× growth vs the 8× threshold, measured at 1250/5000 fences since the quadratic parser cannot finish the test's real sizes); M2 (injected bounded O(n²)) reddens T-U-024 (222.2 ms).
- [x] GATE-MINIMAL: `render.mjs` 111 lines; longest function `sectionSpans` 24 lines; max nesting 3.
- [x] Cold-JIT worst case 164.8 ms → **0.98 ms**; realistic body 2.0 ms → 0.6 ms.
- [x] PRD NFR-002 → `done`; ASM-003's row updated with the measured curve; change-log entry v0.1.7.
- [x] Spec moved to `done/`, dates set.
