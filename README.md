# lifeos

A personal Life OS: a generic, domain-agnostic kernel — a typed entity graph plus an
append-only event log on Supabase/Postgres — where every life domain (health, finance,
relationships, tasks) plugs in as data, not schema. The long-term direction is a
Jarvis-style orchestrator sitting on top via scoped, least-privilege seams; we build
the kernel now and reserve the seams, we do not build the agent.

Stack: Python 3.12, FastAPI, Pydantic v2, Supabase (Postgres + pgvector), Supabase CLI
migrations, pytest, ruff, mypy, Docker for local services.

See [AGENTS.md](AGENTS.md).
