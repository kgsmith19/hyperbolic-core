# Test Ledger

The suites for `services/brain`. All of them run in the `Verify: Tests (Linux)`
(`.github/workflows/brain-ci.yml`).

| Suite | Covers | Command |
| --- | --- | --- |
| `tests/*.test.ts` | Daemon lifecycle, the SQLite WAL state store, the DAG scheduler, crash recovery, and the `brain.task.v1` / `brain.result.v1` contracts. | `npm test` |
| `tests/cli/*.test.ts` | The Brain's CLI surface. | `npm test` |

Add a row when a new suite is introduced. This ledger is historical context for
contributors, not a merge gate — `Verify: Tests (Linux)` is the gate.
