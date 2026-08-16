# LifeOS backend guidance

## Purpose

This directory owns the FastAPI service, typed entity graph, migrations, scheduled jobs, and backend tests.

## Product boundaries

- Before changing domain behavior, read `.agents/invariants.md` and the relevant `.agents/domains/*/CONSTITUTION.md`. Preserve each domain's data, access, provenance, and runtime safety constraints.
- Prefer direct, typed modules and behavior-focused tests.
- Preserve narrow access scopes, provenance envelopes, sensitive-type exclusions, approval-gated outward bill actions, and the ban on money transfers or payments.

## Commands

```bash
python -m pip install -e .[dev]         # install
ruff check .                             # lint
mypy                                     # type-check
pytest                                   # test
python -m uvicorn api.main:app --reload  # API
python -m mcp_server                     # read-only MCP server
```

Tests can erase the database configured in `.env`. Use only an isolated test database.

## Documentation

Operational procedures are in `docs/runbook.md`; architecture decisions are in `docs/adr/`.

## Collaboration boundary

Repository-wide delivery and AI contribution boundaries are defined in `../AGENTS.md`.
