# CLAUDE.md

## What this repo is

The shared spine and idea list every other tool in Kyle's tool portfolio plugs into.

## Read before you act

| Order | File | Why |
|---|---|---|
| 1 | `docs/PRD.md` | **Source of truth.** Living document. |
| 2 | `rules/00-CORE.md` | Principles, halts, output contract |
| 3 | The rule cards a prompt names | Do not read all of them by default |
| 4 | `specs/active/` | What is being built right now |

`docs/SYSTEM-REQUIREMENTS.md` and `docs/DATA-FLOW-DIAGRAM.md` are read when the work touches architecture, interfaces, data, or security.

## STOP conditions

**Do not write a spec, write code, or merge if any of these is true.** Report and ask instead.

1. `docs/PRD.md` does not exist.
2. `docs/PRD.md` contains an unfilled `<placeholder>`.
3. Any `FR-` or `NFR-` has no value in its Status column.
4. The work implements something no PRD requirement asks for. Update the PRD first, or do not build it.
5. The PRD contradicts an active spec.
6. A required variable in `rules/01-BUDGETS.md` is unset.
7. The change needs a new library, service, or third-party integration.
8. Any budget ceiling would be breached.

The PRD is the source of truth in practice, not just in principle. That is what these stops enforce.

## Where things live

```
docs/PRD.md                    source of truth
docs/SYSTEM-REQUIREMENTS.md    what the system must be
docs/DATA-FLOW-DIAGRAM.md      where data comes from, goes, rests
docs/adr/ADR-NNNN-<kebab>.md   decisions with trade-offs
docs/notes/YYYY-MM-DD-<kebab>.md   everything else doc-shaped
specs/active/SPEC-NNNN-<kebab>.md  in progress
specs/done/SPEC-NNNN-<kebab>.md    completed
specs/TEST-LEDGER.md           every test's justification
```

`docs/` root holds **exactly three** `.md` files. Nothing else goes there, ever. Full rules: `rules/04-DOCS.md`.

## Workflow

| Phase | Prompt | Skill |
|---|---|---|
| Explore | `prompts/10-research.md` | `superpowers:brainstorming` |
| Requirements | `prompts/11-prd-create.md` / `12-prd-update.md` | |
| Spec | `prompts/20-spec-write.md` | |
| Isolate | `prompts/31-implement-green.md` | `superpowers:using-git-worktrees` |
| Plan | | `superpowers:writing-plans` |
| Build | | `superpowers:subagent-driven-development` + `test-driven-development` |
| Review | | `superpowers:requesting-code-review` |
| Ship | `prompts/33-integrate-merge.md` | `superpowers:finishing-a-development-branch` |

Full routing and the worktree/subagent topology: `rules/07-SKILLS.md`.

## Non-negotiables

1. **No production code without a failing test that demands it.** Red must be an assertion failure, not an import error (GATE-RED R2).
2. **Every test is justified in `specs/TEST-LEDGER.md` before it is written.** No row, no test.
3. **Cheapest sufficient mechanism.** Type or schema constraint -> lint -> pure function -> DB constraint -> test -> runtime check -> network call -> LLM call. Never reach higher than needed.
4. **Thin slices.** Budget breach means the slice is wrong: stop, report, split, wait.
5. **Docs update in the same commit** as the behavior change, never later.
6. **No abstraction with one caller.** Three instances earn an abstraction; two is a coincidence.
7. **Deletion is progress** and gets reported as progress.

## Budget ceilings (per slice)

```
net source LOC 300 | test LOC 200 | new modules 2 | source files 3
new tables 1 | new columns 6 | new endpoints 1 | new UI surfaces 1
new libraries 0 | new third-party 0 | user stories 1 | new tests 8
red-green cycles before halt 3 | function LOC 40 | file LOC 250 | complexity 8
```

Full set and calibration: `rules/01-BUDGETS.md`. SPEC-0000 in this repo carries a written, explicit exception to `new tables 1` and GATE-SKELETON K3 — see that spec's section 6.

## Commands

```bash
<TBD>             # run the suite
<TBD>             # lint
<TBD>             # typecheck
<TBD>             # build
<TBD>             # run locally
<TBD>             # apply migrations
```

## Project variables

```yaml
PROJECT_NAME:  toolbelt
LANGUAGE:      SQL (Postgres/Supabase) + vanilla JS (no framework, no build step)
FRAMEWORK:     none
DATABASE:      Supabase Postgres, project "toolbelt"
PROPERTY_LIB:  fast-check
MAIN_BRANCH:   main
```

## Review cadence

Every 3 slices: lean review, doc refresh. Every 5: security review, test review. Every 10: process review.

## Never

- Declare a gate passed without showing its command output.
- Edit a test to make it pass without writing down why the test was wrong.
- Add a dependency to avoid writing 30 lines.
- Leave `TODO`, `FIXME`, or commented-out code in a green slice.
- Widen scope mid-slice. Discoveries become spec entries.
- Create `archive/`, `old/`, or `_backup/`. Git is the archive.
- Reference a path outside this repo.
