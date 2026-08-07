# RULE 01: BUDGETS

Ceilings, not targets. Under budget is always better than at budget.

## Defaults

```yaml
# --- per-slice complexity (hard ceilings) ---
MAX_NET_LOC:                300   # non-test source, added minus deleted
MAX_TEST_LOC:               200
MAX_NEW_MODULES:            2     # new classes / modules / components
MAX_SOURCE_FILES_TOUCHED:   3
MAX_TEST_FILES_TOUCHED:     3
MAX_NEW_TABLES:             1
MAX_NEW_COLUMNS:            6
MAX_NEW_ENDPOINTS:          1
MAX_NEW_UI_SURFACES:        1
MAX_NEW_LIBRARIES:          0     # any non-zero needs written approval
MAX_NEW_THIRD_PARTY:        0
MAX_USER_STORIES:           1
MAX_NEW_TESTS:              8
MAX_NEW_CONFIG_KEYS:        2

# --- Phase 0 only (tighter) ---
PHASE0_MAX_NET_LOC:         150
PHASE0_MAX_FILES:           12    # total files in repo, excluding .git and lockfiles
PHASE0_MAX_TESTS:           4

# --- process ---
MAX_RED_GREEN_CYCLES:       3     # failed attempts before HALT and re-spec
MAX_REFACTOR_PASSES:        1
MAX_CONCURRENT_WORKTREES:   3
MAX_SUBAGENTS_PER_WORKTREE: 4
MAX_TASK_MINUTES:           5     # a plan task larger than this is two tasks

# --- review cadence (completed slices) ---
LEAN_REVIEW_EVERY:          3
DOC_REFRESH_EVERY:          3
SECURITY_REVIEW_EVERY:      5
TEST_REVIEW_EVERY:          5
PROCESS_REVIEW_EVERY:       10

# --- quality thresholds ---
MAX_FUNCTION_LOC:           40
MAX_FILE_LOC:               250
MAX_CYCLOMATIC:             8
MAX_UNIT_TEST_MS:           50
MAX_SUITE_SECONDS:          120
MIN_PROPERTY_CASES:         100

# --- project (set per repo in CLAUDE.md) ---
PROJECT_NAME:               <name>
LANGUAGE:                   <lang>
TEST_CMD:                   <command>
LINT_CMD:                   <command>
TYPECHECK_CMD:              <command>
BUILD_CMD:                  <command>
PROPERTY_LIB:               <hypothesis | fast-check | jqwik | proptest | ...>
```

## Breach protocol

A breach is not a failure of the budget. It is evidence the slice is wrong.

1. **STOP.** Do not continue implementing.
2. Emit `BUDGET BREACH`: which ceiling, actual vs limit, why.
3. Propose a split into two or more slices, each under budget.
4. Wait for approval. **Never self-approve.**

Sole exception: a slice that net-deletes code may exceed `MAX_NET_LOC` in the negative direction freely.

## How to split

| Symptom | Split along |
|---|---|
| Too many endpoints | One endpoint per slice |
| Too many tables | Table + its writer in one slice, the reader in the next |
| Too much UI | Data path first, surface second |
| Too many acceptance criteria | Happy path slice, then error-handling slice |
| Too many files touched | The slice crosses a boundary it should not. Find the seam. |
| Too many tests | It is doing more than one thing |

## How to measure

| Metric | Command |
|---|---|
| Net source LOC | `git diff --stat` on non-test files, added minus deleted |
| Test LOC | same, test files only |
| Files touched | `git diff --name-only`, split source vs test |
| New tables / columns | migration file diff |
| New endpoints | route registration diff |
| New libraries | manifest diff |
| New config keys | config diff |

## Calibration

`prompts/44-process-review.md` recalibrates these against real p90 values every `{{PROCESS_REVIEW_EVERY}}` slices.

- Breached often -> slices are under-split. Raise a ceiling only with an argument that the work is irreducible.
- Never approached (p90 under 40% of ceiling) -> the ceiling constrains nothing. Lower it to about p90.
- **When in doubt, lower.** An over-tight ceiling costs one extra split. A loose one costs a slice nobody can review.
