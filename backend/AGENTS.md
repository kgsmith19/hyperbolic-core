# LifeOS backend guidance

This directory owns the FastAPI service, typed entity graph, migrations, scheduled jobs, and backend tests.

Before changing domain behavior, read `.agents/invariants.md` and the relevant `.agents/domains/*/CONSTITUTION.md`. Preserve each domain's data, access, provenance, and runtime safety constraints.

## Commands

- Install: `python -m pip install -e .[dev]`
- Lint: `ruff check .`
- Type-check: `mypy`
- Test: `pytest`
- API: `python -m uvicorn api.main:app --reload`
- Read-only MCP server: `python -m mcp_server`

Tests can erase the database configured in `.env`. Use only an isolated test database. Operational procedures are in `docs/runbook.md`; architecture decisions are in `docs/adr/`.

Prefer direct, typed modules and behavior-focused tests. Preserve narrow access scopes, provenance envelopes, sensitive-type exclusions, approval-gated outward bill actions, and the ban on money transfers or payments.

Repository-wide delivery and AI contribution boundaries are defined in `../AGENTS.md`.
