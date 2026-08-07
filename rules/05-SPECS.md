# RULE 05: SPECS

A spec is a contract: everything the implementer needs, nothing they must guess. Specs are an official part of the flow and are always correct or they are fixed.

## Scope

A spec describes **this repo only**. Never cross-repo. Never references a path outside the repo.

## Identity

`SPEC-NNNN-kebab-title.md`. Four digits, zero-padded, never reused. One spec, one thin slice, one shippable change.

Front matter (in addition to `rules/04-DOCS.md`):

```yaml
spec_id: SPEC-0007-reject-expired-sessions
slice: SL-007
status: draft | active | done
completed: YYYY-MM-DD or blank
traces: [FR-009, NFR-003, SR-004]
```

## Required sections

From `templates/SPEC.md`. None may be omitted; write "None, because \<reason\>" rather than leaving a section blank.

| # | Section | Hard rule |
|---|---|---|
| 1 | In one sentence | If it needs two sentences, it is two specs |
| 2 | Why this, why now | Names the requirement and the uncertainty this removes |
| 3 | Scope / Out of scope | **Out-of-scope needs at least three entries** |
| 4 | Acceptance criteria | Given/When/Then, literal values, at least one failure case |
| 5 | Properties | Walk all nine kinds in `rules/06-TESTS.md`; error-totality present or excluded with a reason |
| 6 | Budget declaration | Every line under its ceiling, filled **before** implementation |
| 7 | Changes | Interfaces, data (with down migration), files expected to change |
| 8 | Test plan | Every row passed GATE-TEST-JUSTIFIED on paper |
| 9 | Risks | |
| 10 | Rollback plan | Concrete enough to execute at 3am without thinking |
| 11 | Assumptions made | Filled by the implementer, not in advance |
| 12 | Definition of Done | Every box checked with evidence before moving to `done/` |

## Writing rules

- **No implementation.** "Then the response is `409` with body `{"error":"duplicate_title"}`" is right. "Then the service layer throws `DuplicateError`" is wrong.
- **Literal values only.** Not "a valid email" but `alice@example.com`. Not "an expired token" but a token with `exp` 1 second in the past.
- Every `AC` independently verifiable. One failing must not make another impossible to evaluate.
- Every `AC` traces to a requirement **in this spec's declared scope**, not outside it.
- Passes `rules/03-WRITING.md`.

## Lifecycle

```
draft ──GATE-SPEC──> specs/active/ ──Definition of Done──> specs/done/
```

| Rule | |
|---|---|
| A spec enters `active/` only after passing GATE-SPEC | `rules/02-GATES.md` |
| A spec leaves `active/` only via its Definition of Done, or by deletion with a reason | |
| A spec idle in `active/` for 30 days is a halt: finish it or delete it | Caught by doc refresh |
| Two specs in `active/` must not modify the same file, unless running the worktree-parallel flow with an explicit reconciliation | `rules/07-SKILLS.md` |
| A PRD change that contradicts an active spec halts that spec until reconciled | |

## Splitting

Split **before** writing the spec, never after discovering the breach. See `rules/01-BUDGETS.md` for the symptom-to-seam table.

If a slice cannot be brought under budget by splitting, the PRD slice plan is wrong. Fix the PRD, do not widen the budget.

## Relationship to superpowers

`superpowers:writing-plans` produces a task list of 2-5 minute steps. **The spec is the design contract; the plan is the execution breakdown.** The plan derives from the spec and never adds behavior the spec does not require. See `rules/07-SKILLS.md`.
