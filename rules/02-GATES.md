# RULE 02: GATES

Every gate is a command plus an expected result. **Never declare a gate passed without running its command and showing the output.**

## GATE-RED: a test is legitimately red

| # | Check | Verified by |
|---|---|---|
| R1 | The test runs and fails | `{{TEST_CMD}} <id>` exits non-zero |
| R2 | It fails on an **assertion**, not a collection or import error | Output names the assertion, not `ImportError` / `ModuleNotFound` / `SyntaxError` |
| R3 | The message shows expected and actual | Both appear |
| R4 | It fails for the intended reason | Reason written in the spec before running, matches output |
| R5 | It names its `AC-`/`PROP-` and through it an `FR-`/`NFR-` | ID in the test name or docstring |
| R6 | It is registered in `specs/TEST-LEDGER.md` with a justification | Row exists, all columns filled |
| R7 | No production code written for it yet | `git diff` touches only test files |

**R2 is the one that matters most.** A test that "fails" because the module does not exist proves nothing and will go green when the wrong thing is built. Write the minimum stub (empty function, route returning `501`) so the failure is about behavior.

## GATE-GREEN: a slice is legitimately green

| # | Check | Command |
|---|---|---|
| G1 | Target tests pass | `{{TEST_CMD}} <ids>` exits 0 |
| G2 | Whole suite passes | `{{TEST_CMD}}` exits 0 |
| G3 | Lint clean | `{{LINT_CMD}}` exits 0 |
| G4 | Types clean | `{{TYPECHECK_CMD}}` exits 0 |
| G5 | Build succeeds | `{{BUILD_CMD}}` exits 0 |
| G6 | Every budget respected | Diff stats vs each ceiling |
| G7 | **No line in the diff is unrequired** by a failing test or an explicit `AC` | Line-by-line justification |
| G8 | Suite runtime under `{{MAX_SUITE_SECONDS}}` | Timed output |
| G9 | Docs updated in the same commit if behavior, interface, or data changed | Diff includes the doc |
| G10 | No new `TODO`, `FIXME`, commented-out code, or dead branch | grep clean |

G7 is where over-building is caught. Read your own diff and name the test that demanded each line. Lines with no answer get deleted.

## GATE-SPEC: a spec is ready to implement

| # | Check |
|---|---|
| S1 | Every `AC` is Given/When/Then with literal values, no placeholders |
| S2 | Every `AC` and `PROP` traces to a requirement ID that exists in the PRD |
| S3 | Declared budget is under every ceiling |
| S4 | Out-of-scope list has at least three entries |
| S5 | At least one `AC` is a failure case |
| S6 | Error-totality property present, or excluded with a written reason |
| S7 | Every data change has a down migration |
| S8 | No `AC` or `PROP` describes an implementation |
| S9 | Every planned test passed GATE-TEST-JUSTIFIED on paper |
| S10 | A rollback plan exists |
| S11 | Passes `rules/03-WRITING.md` |

## GATE-TEST-JUSTIFIED: a test earns its place

Every answer must be yes. Any no: delete the test, or fix it and re-run.

| # | Question |
|---|---|
| J1 | Does it trace to a real `AC` or `PROP`? |
| J2 | Does it name a failure mode a **user or operator** would notice? |
| J3 | Does it fail when that failure is introduced? (Mutation-verify.) |
| J4 | Is there no cheaper mechanism (type, schema, constraint, lint) that catches it? |
| J5 | Does no other test already catch it? |
| J6 | Is it at the cheapest level that can catch it? |
| J7 | Does it have a written deletion criterion? |
| J8 | Is it deterministic? (No wall clock, network, unpinned seed, or order dependence.) |

## GATE-MINIMAL: nothing extra was built

| # | Check |
|---|---|
| M1 | Every diff line demanded by a test or `AC` (same as G7) |
| M2 | Zero abstractions with one caller |
| M3 | Zero interfaces with one implementation |
| M4 | Zero config values nobody configures |
| M5 | Zero `else` branches no test reaches |
| M6 | Zero swallowed exceptions |
| M7 | Zero new dependencies, or an approved exception recorded |
| M8 | Every new function under `{{MAX_FUNCTION_LOC}}` lines and `{{MAX_CYCLOMATIC}}` complexity |
| M9 | Every new file under `{{MAX_FILE_LOC}}` lines |
| M10 | Something was deleted, or the report states why nothing needed deleting |

## GATE-PROPERTY: property tests are real

| # | Check |
|---|---|
| PR1 | Every spec `PROP-` has exactly one property test |
| PR2 | Each runs at least `{{MIN_PROPERTY_CASES}}` generated cases |
| PR3 | Each generator's domain is written down, including required edge values |
| PR4 | Each has a pinned, recorded seed |
| PR5 | Shrinking enabled, producing a minimal counterexample |
| PR6 | **Not vacuous:** break the code deliberately and confirm the property fails |

PR6 is the property equivalent of R2. "The result is a list" passes against almost any bug.

## GATE-DOC: documentation is current

| # | Check |
|---|---|
| D1 | Every `FR`/`NFR` has a status: `not-started`, `in-slice-NNN`, `done`, `dropped` |
| D2 | No doc's `updated` date precedes the last behavior change it describes |
| D3 | Zero broken internal links |
| D4 | Zero orphan docs (unreferenced by README, PRD, or another doc) |
| D5 | Zero unfilled `<placeholders>` |
| D6 | Complete front matter on every file in `docs/` and `specs/` |
| D7 | `docs/` root holds exactly three `.md` files |

## GATE-SHIP: safe to merge

| # | Check |
|---|---|
| SH1 | GATE-GREEN passes on the integration branch, not only per worktree |
| SH2 | GATE-DOC passes |
| SH3 | Every spec in the batch passed its Definition of Done |
| SH4 | Lean review, security review, and doc refresh ran; zero P0 findings open |
| SH5 | Every migration has a tested down path |
| SH6 | Zero secrets in the diff or in history |
| SH7 | PR description lists delivered requirement IDs and the rollback plan |
| SH8 | Branch is rebased on current `main` and the full suite is green after rebase |

Any SH failing blocks the merge. No override.

## Per-artifact self-checks

`GATE-PRD`, `GATE-SYSREQ`, `GATE-DFD`, and `GATE-SPEC-DONE` live in the Appendix of their own template in `templates/`, next to the thing being checked.
`GATE-LEAN`, `GATE-SECURITY`, `GATE-SUITE`, `GATE-PROCESS` live in their review prompt.
