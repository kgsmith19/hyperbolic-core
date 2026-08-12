# Test Ledger

A running record of this repository's test suites: what exists, what it covers, and the result of its most recent run. Historical context for contributors, not a merge gate — `PR Gate` is the gate.

The detailed, per-test regression rationale that used to live here (`specs/TEST-LEDGER.md`) is retired; that reasoning is preserved in git history (see the deleted file's last revision) and, going forward, in commit messages and `AGENTS.md`'s "do not weaken or delete a regression test" rule.

| Suite | Covers | Command | Last run | Result |
| --- | --- | --- | --- | --- |
| `hooks/*.test.mjs` | Guard, budget, directive, lane, route, engine, and other hook logic | `npm test` | 2026-08-12 | pass (see `npm run covgate` for changed-file coverage floors) |
| `kernel/**/*.test.mjs` | Bounded task runner, adapters, ledger, guard/guardhook | `npm test` | 2026-08-12 | pass |
| `runner/runner.test.mjs` | Directive execution loop, singleton pid handling | `npm test` | 2026-08-12 | pass |
| `gui/server.test.mjs` | Loopback API surface, `--ui-dist` static serving | `npm test` | 2026-08-12 | pass |
| `ui/e2e/contract.spec.ts` | React UI against a real, sandboxed ACC server (guards/vault/spending/start-work/kernel) | `cd ui && ACC_DIR=.. npm run e2e` | 2026-08-12 | pass |
| `shim/claude.test.ps1`, `watcher/*.test.ps1` | Windows launch shim and cap-watcher | CI `windows-integration` job | — | — |

Add a row when a new suite is introduced. Update a row's "Last run"/"Result" when it materially changes — this is not meant to be updated on every CI run.
