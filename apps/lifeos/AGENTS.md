# LifeOS repository guidance

LifeOS is one product with two applications:

- `backend/`: FastAPI, the typed entity graph, Postgres migrations, jobs, and tests.
- `frontend/`: React, strict TypeScript, browser tests, and the production UI.

Read the nearest `AGENTS.md` before changing either application. Backend domain changes must also preserve `backend/.agents/invariants.md` and the relevant domain constitution. Generated frontend API types are read-only; regenerate them from the backend contract.

## Essential commands

- Backend setup: `cd backend && python -m pip install -e .[dev]`
- Backend checks: `cd backend && ruff check . && mypy && pytest`
- Frontend setup: `cd frontend && npm ci`
- Frontend checks: `cd frontend && npm run lint && npx tsc -b && npm run test && npm run e2e && npm run build`

Tests use the configured database and may erase its contents. Use only an isolated LifeOS test database, never production.

## Engineering guidance

- Make the smallest clear change that completely resolves its linked GitHub Issue.
- Reuse existing modules and components before adding dependencies or layers.
- Delete obsolete code and avoid duplicate implementations.
- Preserve behavior-focused tests; never weaken assertions to make a gate pass.
- Keep secrets out of source control. Every `VITE_` value is public by design.

Product runtime safeguards remain mandatory: preserve provenance, keep sensitive types out of generic agent tools, retain narrow domain scopes, require the explicit human approval flow for outward bill actions, and never initiate money transfers or payments.

## Delivery

GitHub Issues are the durable work source. The root `.github/workflows/ci.yml` is the only merge gate; its terminal check is `PR Gate`. It verifies both applications and deploys from `main` only when repository variables enable deployment. `ops.yml`, `backup.yml`, and `release-smoke.yml` are operational workflows, not merge gates.

AI coding agents may create assigned branches, commits, Issues, and pull requests. They must not submit reviews, approve or block pull requests, request reviewers, or post unsolicited comments. They may answer in an Issue or pull request only when explicitly tagged with a direct question.
