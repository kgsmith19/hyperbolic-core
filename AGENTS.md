# lifeos

Personal Life OS: domain-agnostic kernel (typed entity graph + append-only event log)
on Supabase; life domains plug in as data, not schema.

Stack: Python 3.12, FastAPI, Pydantic v2, Supabase (Postgres + pgvector), pytest, ruff, mypy.

Commands (venv at `.venv`, DB creds in `.env`):
- test: `.venv\Scripts\python -m pytest`
- lint: `.venv\Scripts\python -m ruff check .` then `.venv\Scripts\python -m mypy`
- run: `.venv\Scripts\python -m uvicorn api.main:app --reload`

Rules: `.agents/invariants.md` (project invariants), `.agents/domains/` (per-cell constitutions).
Classify task tier per folder-level rules before any code.
