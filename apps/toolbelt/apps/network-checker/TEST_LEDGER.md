# Test Ledger

A running record of this app's test suites: what exists, what it covers, and the result of its most recent run. Historical context for contributors, not a merge gate — `Verify: Tests (Linux)` is the gate.

| Suite | Covers | Command | Last run | Result |
| --- | --- | --- | --- | --- |
| `backend/tools/check.sh` | Deterministic diagnostic scanners and the CLI/dashboard's own test fixtures | `bash backend/tools/check.sh` | 2026-08-17 | pass — 491 tests in 10.4s, no network dependency |

Add a row when a new suite is introduced. Update a row's "Last run"/"Result" when it materially changes — this is not meant to be updated on every CI run.
