# Test Ledger

The suites for `services/llm-handler`. All of them run in the `Shell PR Gate`
(`.github/workflows/shell-ci.yml`).

| Suite | Covers | Command |
| --- | --- | --- |
| `tests/*.test.ts` | Handler A's deployed service surface. | `npm test` |

Add a row when a new suite is introduced. This ledger is historical context for
contributors, not a merge gate — `Shell PR Gate` is the gate.
