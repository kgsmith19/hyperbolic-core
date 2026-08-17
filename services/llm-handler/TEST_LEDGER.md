# Test Ledger

The suites for `services/llm-handler`. All of them run in the `Verify: Tests (Linux)`
(`.github/workflows/shell-ci.yml`).

| Suite | Covers | Command |
| --- | --- | --- |
| `tests/*.test.ts` | Handler A's deployed service surface. | `npm test` |

Add a row when a new suite is introduced. This ledger is historical context for
contributors, not a merge gate — `Verify: Tests (Linux)` is the gate.
