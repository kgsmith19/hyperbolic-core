# LifeOS repository guidance

**Location note.** This tree is a `git subtree` copy of `kgsmith19/lifeos` inside the `hyperbolic-core` monorepo. "`.github/workflows/`" below means `apps/lifeos/.github/workflows/`, which GitHub does **not** execute — these files are inert here. The live merge gate, deploy, backup, and ops automation run only from the standalone `kgsmith19/lifeos` repo. Never relocate these workflows to hyperbolic-core's root `.github/workflows/`.

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

GitHub Issues are the durable work source. The merge gate is the REPOSITORY ROOT's `.github/workflows/lifeos-ci.yml`, terminal check `LifeOS PR Gate`, which runs this app's backend and frontend suites. This directory's own `.github/workflows/` is INERT -- GitHub only executes workflows from the repository root -- so `ci.yml`, `ops.yml` and `backup.yml` here run nothing, and `ci.yml` must never be copied to the root: its `build-backend` job carries no repository-variable gate and would publish a Docker image on every push to `main` (see the repo-root AGENTS.md invariant). Deployment is driven by the root's own `deploy.yml`, not from here.

AI coding agents may create assigned branches, commits, Issues, and pull requests. They must not submit reviews, approve or block pull requests, request reviewers, or post unsolicited comments. They may answer in an Issue or pull request only when explicitly tagged with a direct question.
