# Test Ledger

A running record of this app's test suites: what exists, what it covers, and the result of its most recent run. Historical context for contributors, not a merge gate — `Verify: Tests (Linux)` is the gate.

The detailed, per-test rationale that used to live here (`specs/TEST-LEDGER.md`) is retired; that reasoning is preserved in git history and, going forward, in commit messages.

| Suite | Covers | Command | Last run | Result |
| --- | --- | --- | --- | --- |
| `tests/*.test.mjs` | Shared `core`/`idea` Supabase schemas: constraints, dependencies, retention, RLS, scores, seed | `node --test "tests/*.test.mjs"` | 2026-08-12 | pass (calls the live Supabase project) |
| `guards/*.test.mjs` | The standalone `PreToolUse` guard hook and its config CLI | `cd guards && node --test "*.test.mjs"` | 2026-08-12 | pass |
| `tests/validate-manifests.test.mjs` | `tool.json` manifest validator (`scripts/validate-manifests.mjs`, `npm run manifests:check`): schema-shape conformance against `tool.schema.json` (TB-1a), global schema-ownership uniqueness including the root spine's core/idea exception (TB-5), a deliberate cross-manifest collision fixture run through the real CLI, canonical sha256 determinism for `--registry` mode, and two mutation-testing regressions (non-root collusion on an exception-eligible schema name; a malformed non-array `schemas` field) | `node --test tests/validate-manifests.test.mjs` (also runs as part of `node --test "tests/*.test.mjs"`) | 2026-08-12 | pass (22/22; no live-Supabase dependency) |

See `apps/prompt-organizer/TEST_LEDGER.md`, `apps/network-checker/TEST_LEDGER.md`, and `apps/idea-intake/TEST_LEDGER.md` for those apps' own suites. Idea Intake's suite (independent security review, Finding 39) is now also run by `Verify: Tests (Linux)` itself, against a `postgres:` service container, not just locally.

Add a row when a new suite is introduced. Update a row's "Last run"/"Result" when it materially changes — this is not meant to be updated on every CI run.
