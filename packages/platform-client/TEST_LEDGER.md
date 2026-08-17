# Test Ledger

The suites for `packages/platform-client`. All of them run in the `Verify: Tests (Linux)`
(`.github/workflows/shell-ci.yml`).

| Suite | Covers | Command |
| --- | --- | --- |
| `tests/` | Supabase Auth-backed sign-in and authed fetch, and the ADR-03 frozen interface in `src/types.ts`. | `npm test` |

Add a row when a new suite is introduced. This ledger is historical context for
contributors, not a merge gate — `Verify: Tests (Linux)` is the gate.
