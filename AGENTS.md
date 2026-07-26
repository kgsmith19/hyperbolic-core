# lifeos

Personal Life OS: domain-agnostic kernel (typed entity graph + append-only event log)
on Supabase; life domains plug in as data, not schema.

Stack: Python 3.12, FastAPI, Pydantic v2, Supabase (Postgres + pgvector), pytest, ruff, mypy.

Commands (venv at `.venv`, DB creds in `.env`):
- test: `.venv\Scripts\python -m pytest` — WARNING: tests wipe the database in
  `.env`; point `.env` at the lifeos-test project, never prod (docs/runbook.md).
- lint: `.venv\Scripts\python -m ruff check .` then `.venv\Scripts\python -m mypy`
- run: `.venv\Scripts\python -m uvicorn api.main:app --reload` — local dev sets
  `LIFEOS_AUTH_MODE=disabled` in `.env`; deployed runs verify Supabase JWTs (ADR 008).
- deploy: merge to main → GitHub Actions checks, builds, migrates, deploys (docs/runbook.md).

Rules: `.agents/invariants.md` (project invariants), `.agents/domains/` (per-cell constitutions).
Classify task tier per folder-level rules before any code.
