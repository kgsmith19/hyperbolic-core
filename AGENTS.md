# lifeos

Personal Life OS: domain-agnostic kernel (typed entity graph + append-only event log)
on Supabase; life domains plug in as data, not schema.

Stack: Python 3.12, FastAPI, Pydantic v2, Supabase (Postgres + pgvector), pytest, ruff, mypy, Docker.

Commands (placeholders until the kernel scaffold session lands them):
- test: `pytest`
- lint: `ruff check . && mypy src`
- run: `uvicorn src.api.main:app --reload`

Rules: `.agents/invariants.md` (project invariants), `.agents/domains/` (per-cell constitutions).
Classify task tier per folder-level rules before any code.
