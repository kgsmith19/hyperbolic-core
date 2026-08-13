# Test Ledger

A running record of this app's test suites: what exists, what it covers, and the result of its most recent run. Historical context for contributors, not a merge gate — `Toolbelt PR Gate` is the gate.

The detailed, per-test rationale that used to live here (`specs/TEST-LEDGER.md`) is retired; that reasoning is preserved in git history and, going forward, in commit messages.

| Suite | Covers | Command | Last run | Result |
| --- | --- | --- | --- | --- |
| `tests/*.test.mjs` | `prompt` schema: list/search, versions, variables/render, tags, usage tracking, archive | `node --test "tests/*.test.mjs"` | 2026-08-13 | pass (85/85; calls the live Supabase project, plus real-Postgres suites below) |
| Playwright critical browser journey | End-to-end UI flow against a served `web/` | `PLAYWRIGHT_BASE_URL=http://localhost:8812 npx playwright test --config playwright.config.mjs` | 2026-08-12 | pass |
| `tests/get-prompt.test.mjs` (m4-03) | `prompt.get_prompt` RPC: contract shape, pinned-vs-latest resolution, PT404/PT422 raise conditions, p_values-over-p_config merge order, p_sections override, RLS/security-invoker boundary, down migration. Real PostgreSQL 16 (local), not live Supabase -- `get_prompt` is not deployed live yet (confirmed: `rpc/get_prompt` returns PGRST202) | `node --test tests/get-prompt.test.mjs` | 2026-08-13 | pass (15/15) |
| `tests/seed.test.mjs` (m4-03) | Starter-seed migration `20260813130000_prompt_seed_starters.sql`: PO-4 per-category coverage, the `idea-intake/optimize-v1` contract, idempotent re-apply, pre-existing-title collision safety, exact-title down migration, prompt_version cascade, and non-superuser-owner deployability (the FORCE RLS `no force`/`force` wrapper). Real PostgreSQL 16 (local) | `node --test tests/seed.test.mjs` | 2026-08-13 | pass (8/8) |
| `tests/performance.test.mjs` extension (m4-03) | PO-2: `rpc/get_prompt` p95 over 50 warm calls under 150ms, engine-level against real PostgreSQL 16 (local); network/PostgREST layer unverifiable until `get_prompt` is deployed live | `node --test tests/performance.test.mjs` | 2026-08-13 | pass (5/5; measured p95 ~0.3ms engine-level) |

Add a row when a new suite is introduced. Update a row's "Last run"/"Result" when it materially changes — this is not meant to be updated on every CI run.
