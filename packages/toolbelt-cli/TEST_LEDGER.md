# Test Ledger

The suites for `packages/toolbelt-cli`. All of them run in the `Verify: Tests (Linux)`
(`.github/workflows/shell-ci.yml`).

| Suite | Covers | Command |
| --- | --- | --- |
| `tests/*.test.mjs` | The three-step new-tool scaffold lifecycle (TB-3). | `npm test` |

Add a row when a new suite is introduced. This ledger is historical context for
contributors, not a merge gate — `Verify: Tests (Linux)` is the gate.
