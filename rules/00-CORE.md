# RULE 00: CORE

Always in effect. Every prompt in `prompts/` inherits this. Do not restate it; obey it.

## Sources of truth, in order

| Rank | Artifact | Governs |
|---|---|---|
| 1 | `docs/PRD.md` | What the product does and why. **Living document.** If code and PRD disagree, one is a defect. Say which. |
| 2 | `docs/SYSTEM-REQUIREMENTS.md` | What the system must be |
| 3 | `docs/DATA-FLOW-DIAGRAM.md` | Where data comes from, goes, rests |
| 4 | `specs/active/*.md` | What is being built right now |
| 5 | `CLAUDE.md` | How to work in this repo |

Nothing outranks the PRD. Code implementing something absent from the PRD is either a PRD gap (update the PRD first) or waste (delete it). There is no third option.

## Principles

1. **Cheapest sufficient mechanism.** Ascending cost: type or schema constraint -> lint rule -> pure function -> database constraint -> test -> runtime check -> network call -> LLM call. Never reach higher than needed. An LLM call needs a written reason no deterministic logic suffices.
2. **First principles.** Before adding a mechanism, state the necessity that demands it. "Common practice" is not a reason.
3. **Everything justifies its existence.** Every file, dependency, test, doc, config key, abstraction: what breaks if this is deleted? No answer means delete.
4. **Thin slices.** A slice that does not fit in your head is not reviewable.
5. **Objective over subjective.** Every gate is a command with an expected exit code, or a countable value with a threshold.
6. **Traceability both ways.** Every test names a property or acceptance criterion; every one of those names a requirement. Orphans are defects.
7. **No speculative generality.** Build the requirement in front of you. Abstractions are earned at the third instance, never predicted.
8. **Deletion is progress** and gets reported as progress.

## Rule cards

Read the ones a prompt names. Do not read all of them by default.

| Card | Covers |
|---|---|
| `rules/01-BUDGETS.md` | Complexity ceilings, breach protocol |
| `rules/02-GATES.md` | Every objective gate |
| `rules/03-WRITING.md` | Four-reader test, banned words |
| `rules/04-DOCS.md` | Folder contract, naming, lifecycle |
| `rules/05-SPECS.md` | Spec structure, splitting, active/done |
| `rules/06-TESTS.md` | Property kinds, levels, justification, ledger |
| `rules/07-SKILLS.md` | Superpowers routing, worktrees, subagents |

## Variable syntax

`{{VAR}}` set in a prompt's `## CONFIG` block; defaults in `rules/01-BUDGETS.md`. **An unset variable is a halt, never a guess.**

`<!--OPTIONAL:id-->` ... `<!--/OPTIONAL:id-->` fences a droppable section. With `LEAN_MODE: true`, ignore every fenced block not listed in `KEEP_SECTIONS`. Every prompt stays valid with any subset removed.

`<angle brackets>` are fill-ins. A deliverable containing one fails its gate.

## Halt conditions

Stop, report, ask. Never proceed past these.

| # | Condition |
|---|---|
| H1 | A required variable is unset |
| H2 | `docs/PRD.md` is missing, has unfilled placeholders, or has a requirement with no status |
| H3 | Any budget ceiling would be breached |
| H4 | `{{MAX_RED_GREEN_CYCLES}}` reached without green |
| H5 | Spec contradicts PRD, or two requirements contradict each other |
| H6 | An acceptance criterion cannot be made objective without a product decision |
| H7 | A new library, service, or third-party integration is needed |
| H8 | A destructive or irreversible action is needed beyond the approved merge path |
| H9 | Secrets or PII would be handled in a way no requirement describes |
| H10 | You are writing code with no failing test demanding it |

## Banned behaviors

- Declaring a gate passed without running its command and showing output.
- Writing production code before a red test exists, except the minimum stub required by GATE-RED R2.
- Editing a test to make it pass, unless the test is provably wrong and the reason is written down.
- Adding a dependency to avoid writing 30 lines.
- Creating an abstraction with one caller.
- Leaving `TODO`, `FIXME`, or commented-out code in a green slice.
- Widening scope mid-slice. Discoveries become new spec entries, not more code.
- Marking a slice done with stale docs.

## Output contract

Every prompt ends with this block. Structure is fixed; omit no heading.

```markdown
## RUN REPORT
**Prompt:** <name> | **Slice:** SL-NNN | **Spec:** SPEC-NNNN
**Outcome:** PASS | HALT | BUDGET-BREACH

### Gates
| Gate | Result | Evidence (command + exit code) |

### Budget
| Metric | Actual | Ceiling | Status |

### Changed
| Path | Action | Why |

### Traceability
Covered: <FR-...> | Tests +: <T-...> | Tests -: <T-...> | Orphans: <ids or none>

### Assumptions
| ID | Assumption | Why needed | How to verify | Blast radius |

### Deleted
<what and why. "nothing" three runs running is a yellow flag.>

### Next
<the single next action, or the decision needed from a human.>
```

**Assumption discipline:** every gap the spec did not cover but you filled gets a row. An empty table on a non-trivial slice means you did not look. Hiding places: default values, error wording, ordering, timezones, empty input, duplicate input, retention, what null means.
