# Test Ledger

This is a monorepo — each app under `apps/` owns its own test suites and, where relevant, its own `TEST_LEDGER.md`. This root ledger tracks only the CI entry points.

| Suite | Covers | Command | Last run | Result |
| --- | --- | --- | --- | --- |
| `Toolbelt PR Gate` | `apps/toolbelt/**` (root tools, `guards/`, `prompt-organizer`, `network-checker`) | `.github/workflows/toolbelt-ci.yml` | 2026-08-12 | pass |
| `ACC PR Gate` | `apps/agentic-command-center/**`, `apps/toolbelt/guards/**` | `.github/workflows/acc-ci.yml` | 2026-08-12 | pass |
| `apps/lifeos`'s own CI | `apps/lifeos/**` | inert here — runs from the standalone `lifeos` repo | — | — |

See `apps/toolbelt/TEST_LEDGER.md` and `apps/agentic-command-center/TEST_LEDGER.md` for suite-level detail within each app.
