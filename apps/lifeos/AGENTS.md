# LifeOS repository guidance

## 🎯 Purpose

LifeOS is one product with two applications: `backend/` (FastAPI, the typed entity graph, Postgres migrations, jobs, and tests) and `frontend/` (React, strict TypeScript, browser tests, and the production UI). This tree is a `git subtree` copy of `kgsmith19/lifeos` inside `hyperbolic-core`. Read the nearest `AGENTS.md` before changing either application.

## 📋 Product Boundaries

- `apps/lifeos/.github/workflows/` is not executed here — GitHub runs workflows only from the repository root — so `ci.yml`, `ops.yml`, and `backup.yml` are inert and are kept only because the standalone `kgsmith19/lifeos` repo still runs them. In this repo the merge gate is the root's `.github/workflows/lifeos-ci.yml`, and the lifecycle (deploy/backup/ops) is owned by the root's `lifeos-deploy.yml`, `lifeos-backup.yml`, and `lifeos-ops.yml` after the cutover (docs/ops/runbook.md, "LifeOS cutover"). Never relocate these workflows to the root: `ci.yml`'s `build-backend` job has no repository-variable gate and would publish a Docker image on every push to `main`.
- Backend domain changes must also preserve `backend/.agents/invariants.md` and the relevant domain constitution.
- Generated frontend API types are read-only; regenerate them from the backend contract.
- Make the smallest clear change that completely resolves its linked GitHub Issue.
- Reuse existing modules and components before adding dependencies or layers.
- Delete obsolete code and avoid duplicate implementations.
- Preserve behavior-focused tests; never weaken assertions to make a gate pass.
- Keep secrets out of source control. Every `VITE_` value is public by design.
- Product runtime safeguards remain mandatory: preserve provenance, keep sensitive types out of generic agent tools, retain narrow domain scopes, require the explicit human approval flow for outward bill actions, and never initiate money transfers or payments.

## ⚙️ Commands

```bash
cd backend && python -m pip install -e .[dev]
cd backend && ruff check . && mypy && pytest
cd frontend && npm ci
cd frontend && npm run lint && npx tsc -b && npm run test && npm run e2e && npm run build
```

Tests use the configured database and may erase its contents. Use only an isolated LifeOS test database, never production.

## ✅ Completion Criteria

GitHub Issues are the durable work source. A change is ready when its linked Issue's acceptance criteria are satisfied, the commands above pass, and the root's `.github/workflows/lifeos-ci.yml` terminal check `Verify: LifeOS` succeeds, running this app's backend and frontend suites as the 8th stage of the root's sequential `pr-verify.yml` chain. Deployment is driven by the root's own `deploy.yml`, not from here.

## 🔒 Collaboration Boundary

AI coding agents may create assigned branches, commits, Issues, and pull requests. They must not submit reviews, approve or block pull requests, request reviewers, or post unsolicited comments. They may answer in an Issue or pull request only when explicitly tagged with a direct question.
