# RULE 08: SUBAGENT ROLES

> Relocated from `AGENTS.md` during the `agent-engineering-standard` migration (2026-08-08): that filename is now the repo's vendor-neutral operational map (see the real `/AGENTS.md`), a different and higher-priority use of the name. This file's content is unchanged and still describes the worktree/subagent pattern in `rules/07-SKILLS.md` -- superseded as the default (the standard prefers one primary agent unless a measured comparison justifies more), kept for any slice that still deliberately chooses it.

Roles and permissions for subagents working in this repo. Governed by `rules/07-SKILLS.md`.

## The rule that matters most

**A subagent receives its spec, its single task, `rules/02-GATES.md`, and `rules/06-TESTS.md`. Nothing else.**

A subagent handed the whole repository history loses the task. Narrow context is not a limitation here, it is the mechanism.

## Roles

| Role | Runs | Receives | May write | Must not |
|---|---|---|---|---|
| **Spec author** | Once per slice, in the main worktree | PRD, system requirements, DFD, prior specs in `done/` | `specs/active/SPEC-NNNN-*.md` | Any source or test file |
| **Test author** | Task 1 in every worktree | The spec, `rules/06-TESTS.md`, `rules/02-GATES.md` | Test files, `specs/TEST-LEDGER.md`, minimum stubs required by GATE-RED R2 | Any production logic |
| **Implementer** | One per plan task | The spec, its one task, the failing test output | Only the files its task names | The spec, the PRD, another task's files, any test |
| **Reviewer** | After each task, two stages | The spec, the diff | Nothing. Findings only. | Fix anything itself |
| **Integrator** | Once per batch | All merged specs, the full suite | Docs, PR description, merge | Source files |
| **Auditor** | On review cadence | Whole repo, read-only until `APPLY` is set | Only what its `APPLY` mode permits | Anything outside its scope |

## Two-stage review after every task

| Stage | Question | Blocks on |
|---|---|---|
| 1. Spec compliance | Does the diff satisfy the acceptance criteria it claims, and nothing more? | Any behavior not required by an `AC` or `PROP` |
| 2. Code quality | Does it pass GATE-MINIMAL M1-M10? | Any failing check |

A finding that widens scope becomes a new spec entry. It never becomes more code in this slice.

## Worktree ownership

| Boundary | Owner |
|---|---|
| Worktree + branch | One spec |
| Database (branch, schema, or container) | That worktree alone |
| Migration for a given table | Exactly one slice. Others depend on it. |
| Lockfile | Serialized across worktrees, never concurrent |

## Escalation

| Situation | Action |
|---|---|
| Task fails after `{{MAX_RED_GREEN_CYCLES}}` cycles | Halt this worktree. Others continue. Report both hypotheses: the spec is wrong, or the test is wrong. |
| A subagent needs a file outside its task | Halt. Either the plan is wrong or the spec is. |
| A subagent wants to change a test | Halt. Never silent. |
| Any budget ceiling would break | Halt the worktree, propose a split. |
| Two worktrees conflict on merge | The lower slice number wins. The other rebases and re-runs its full suite. |

## Tool permissions

| Role | Read | Write | Shell | Network |
|---|---|---|---|---|
| Spec author | repo | `specs/` | no | no |
| Test author | repo | tests, ledger, stubs | test runner only | no |
| Implementer | its task's files + spec | its task's files | test, lint, typecheck, build | no |
| Reviewer | repo | nothing | test runner | no |
| Integrator | repo | docs, git | full | git remote only |
| Auditor | repo | per `APPLY` mode | read-only analysis | no |
