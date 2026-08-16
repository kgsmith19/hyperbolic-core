# LifeOS

LifeOS is a personal data system built around a typed entity graph and append-only event log. The backend and UI live together so one pull request can verify API and browser behavior as a single product.

## Quick start

Backend (Python 3.12+):

```bash
cd backend
python -m pip install -e '.[dev]'
ruff check .
mypy
pytest
```

Frontend (Node 24+):

```bash
cd frontend
cp .env.example .env
npm ci
npm run dev
```

The frontend environment contains only public `VITE_` configuration. Never place a secret in it. Backend tests may erase their configured database; use only an isolated test database.

## Layout

- `backend/` — FastAPI, Postgres migrations, domain jobs, MCP read tools, and Python tests.
- `frontend/` — React, TypeScript, Vitest, Playwright, and the static production bundle.

## Documentation

See [AGENTS.md](AGENTS.md) for repository guidance, [backend/docs/runbook.md](backend/docs/runbook.md) for operations, and the nearest application README for application-specific details.
