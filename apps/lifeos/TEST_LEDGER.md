# Test Ledger

A running record of this app's test suites: what exists, what it covers, and the result of its most recent run. Historical context for contributors, not a merge gate — `PR Gate` is the gate (run from the standalone `lifeos` repo; inert here, see `AGENTS.md`'s location note).

| Suite | Covers | Command | Last run | Result |
| --- | --- | --- | --- | --- |
| Backend (`ruff` + `mypy` + `pytest`) | FastAPI entity graph, domains, migrations, jobs | `cd backend && ruff check . && mypy && pytest` | — | — |
| Frontend (lint + `tsc` + unit + e2e) | React UI, strict TypeScript, browser flows | `cd frontend && npm run lint && npx tsc -b && npm run test && npm run e2e && npm run build` | — | — |

"Last run"/"Result" are tracked from the standalone `lifeos` repo, where this app's CI actually executes. Add a row when a new suite is introduced.
