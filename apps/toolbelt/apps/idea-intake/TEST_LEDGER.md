# Test Ledger

A running record of this app's test suites: what exists, what it covers, and the result of its most recent run. Historical context for contributors, not a merge gate — `Toolbelt PR Gate` is the gate.

Independent security review, Finding 39 (re-verified against current HEAD): this file did not exist before this batch. `.github/workflows/toolbelt-ci.yml` never ran this app's test suite at all and provisioned no PostgreSQL service, so every real-Postgres suite below has only ever run locally by hand, never in CI, until this batch added a `postgres:` service container and a dedicated "Run Idea Intake tests" step (which also fails the job outright if any suite below reports a skip — see that step's own comment).

| Suite | Covers | Command | Last run | Result |
| --- | --- | --- | --- | --- |
| `tests/*.test.mjs` | The full suite below, run together | `node --test "tests/*.test.mjs"` | 2026-08-13 | pass; real-Postgres suites now also gated by `Toolbelt PR Gate`'s `postgres:` service container (Finding 39), no longer local-only |
| `tests/intake-guards.test.mjs` (m3-05) | `intake` schema's three independent immutability layers: guard triggers (II-1 legal transitions, II-3 immutability), column-scoped grants, and RLS -- real PostgreSQL, applying the real committed migration files verbatim | `node --test tests/intake-guards.test.mjs` | 2026-08-13 | pass (real local Postgres) |
| `tests/mark_submitted_to_github_rpc.test.mjs` (PR #8 Finding 8) | The forged-submission fix: narrowed UPDATE grant plus the `intake.mark_submitted_to_github` service-role-only RPC, and that II-1/II-3 stay enforced through it | `node --test tests/mark_submitted_to_github_rpc.test.mjs` | 2026-08-13 | pass (real local Postgres) |
| `tests/registration.test.mjs` / `tests/registration-idempotency.test.mjs` (m3-02/m3-05) | `tool.json` schema conformance, `manifest_hash` parity (TB-1b) against the real registration migration, and real-Postgres upsert idempotency / down-migration safety | `node --test tests/registration.test.mjs tests/registration-idempotency.test.mjs` | 2026-08-13 | pass (real local Postgres for the idempotency half) |
| `tests/migrate-forgepad-e2e.test.mjs` / `tests/migrate-forgepad-mapping.test.mjs` | `tools/migrate-forgepad.mjs`'s mapping logic and end-to-end idempotency/dedup behavior, including the Finding 11 partial-index race fix | `node --test tests/migrate-forgepad-e2e.test.mjs tests/migrate-forgepad-mapping.test.mjs` | 2026-08-13 | pass (real local Postgres) |
| `tests/idea-source-update-grant.test.mjs` (independent review, Finding 35) | `intake.idea.source` is now editable before submission (the UPDATE grant previously omitted it), and that II-3 immutability is unaffected | `node --test tests/idea-source-update-grant.test.mjs` | 2026-08-13 | pass (real local Postgres) |
| `tests/optimization-fk-cascade-and-indexes.test.mjs` (independent review, Findings 36 and 49) | `intake.optimization.input_idea_id`/`output_idea_id` now `ON DELETE CASCADE` (deleting a non-submitted idea with optimization history no longer fails with a foreign-key violation) plus their new supporting indexes, verified via `EXPLAIN` | `node --test tests/optimization-fk-cascade-and-indexes.test.mjs` | 2026-08-13 | pass (real local Postgres) |

Real-Postgres suites detect a usable local `psql` (direct connection, then `sudo -n -u postgres psql`) and self-skip cleanly via node:test's own skip mechanism when neither is reachable -- reported as SKIPPED, never silently omitted and never falsely green. `Toolbelt PR Gate`'s Idea Intake step now fails outright if any suite reports a skip, since a real `postgres:` service container is present there.

See `apps/toolbelt/TEST_LEDGER.md` for the root spine's own suites, `apps/prompt-organizer/TEST_LEDGER.md` and `apps/network-checker/TEST_LEDGER.md` for those apps'.

Add a row when a new suite is introduced. Update a row's "Last run"/"Result" when it materially changes — this is not meant to be updated on every CI run.
