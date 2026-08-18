# Test Ledger

The suites for `packages/ui`. All of them run in the `Platform`
(`.github/workflows/shell-ci.yml`).

| Suite | Covers | Command |
| --- | --- | --- |
| `test/**/*.test.mjs` | Shared design tokens, primitives, and state components. | `npm test` |
| `test/size-check.mjs` | The bundle-size budget. Runs as part of `npm test`. | `npm test` |

Add a row when a new suite is introduced. This ledger is historical context for
contributors, not a merge gate — `Platform` is the gate.
