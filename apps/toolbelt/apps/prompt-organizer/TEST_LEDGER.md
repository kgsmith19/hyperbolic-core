# Test Ledger

A running record of this app's test suites: what exists, what it covers, and the result of its most recent run. Historical context for contributors, not a merge gate — `Toolbelt PR Gate` is the gate.

The detailed, per-test rationale that used to live here (`specs/TEST-LEDGER.md`) is retired; that reasoning is preserved in git history and, going forward, in commit messages.

| Suite | Covers | Command | Last run | Result |
| --- | --- | --- | --- | --- |
| `tests/*.test.mjs` | `prompt` schema: list/search, versions, variables/render, tags, usage tracking, archive | `node --test "tests/*.test.mjs"` | 2026-08-12 | pass (calls the live Supabase project) |
| Playwright critical browser journey | End-to-end UI flow against a served `web/` | `PLAYWRIGHT_BASE_URL=http://localhost:8812 npx playwright test --config playwright.config.mjs` | 2026-08-12 | pass |

Add a row when a new suite is introduced. Update a row's "Last run"/"Result" when it materially changes — this is not meant to be updated on every CI run.
