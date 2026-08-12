# Test Ledger

A running record of this app's test suites: what exists, what it covers, and the result of its most recent run. Historical context for contributors, not a merge gate — `Toolbelt PR Gate` is the gate.

The detailed, per-test rationale that used to live here (`specs/TEST-LEDGER.md`) is retired; that reasoning is preserved in git history and, going forward, in commit messages.

| Suite | Covers | Command | Last run | Result |
| --- | --- | --- | --- | --- |
| `tests/*.test.mjs` | Shared `core`/`idea` Supabase schemas: constraints, dependencies, retention, RLS, scores, seed | `node --test "tests/*.test.mjs"` | 2026-08-12 | pass (calls the live Supabase project) |
| `guards/*.test.mjs` | The standalone `PreToolUse` guard hook and its config CLI | `cd guards && node --test "*.test.mjs"` | 2026-08-12 | pass |

See `apps/prompt-organizer/TEST_LEDGER.md` and `apps/network-checker/TEST_LEDGER.md` for those apps' own suites.

Add a row when a new suite is introduced. Update a row's "Last run"/"Result" when it materially changes — this is not meant to be updated on every CI run.
