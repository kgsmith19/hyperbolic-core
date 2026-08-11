# lifeos

Personal Life OS built on a typed entity graph and append-only event log in
Supabase. Life domains are data and application modules, not new kernel schema.

Stack: Python 3.12+, FastAPI, Pydantic v2, Postgres with pgvector, pytest,
ruff, and mypy.

The shared [agent-engineering-standard](https://github.com/kgsmith19/agent-engineering-standard)
is an experimental, informational reference pinned in `.agent/standard.lock`.
This repository owns its implementation choices and CI.

## Essential commands

Run from the repository root. Local examples assume the virtual environment is
`.venv`.

- Install: `python -m pip install -e .[dev]`
- Test: `.venv\Scripts\python -m pytest`
- Lint: `.venv\Scripts\python -m ruff check .`
- Type-check: `.venv\Scripts\python -m mypy`
- API: `.venv\Scripts\python -m uvicorn api.main:app --reload`
- Read-only MCP server: `.venv\Scripts\python -m mcp_server`

Tests use the database configured in `.env` and can erase its contents. Point
`.env` at the LifeOS test project, never production; see `docs/runbook.md`.

Operational commands and their contracts are documented beside the relevant
domain and in `docs/runbook.md`. Important entry points include calendar,
CPAP, and briefing jobs; intentions import; bill extraction, verification, and
dispute drafting; and the SimpleFIN/CSV money ingestion commands.

## Engineering guidance

- Prefer the smallest clear change that fully satisfies the linked Issue.
- Reuse existing modules before adding dependencies, files, or abstractions.
- Delete code made obsolete by the change.
- Keep ruff and mypy clean.
- Add behavior-focused tests at the appropriate tier: unit for pure logic,
  integration for Postgres boundaries, and API end-to-end tests for HTTP flows.
- Preserve unrelated work and do not weaken tests to make a change pass.
- The web client lives in the sibling `lifeos-ui` repository.

## Work and delivery

GitHub Issues are the durable source for requested work. Implement one focused
slice on a short-lived branch, run the relevant local checks, and open a pull
request that links the Issue and states the evidence.

`.github/workflows/ci.yml` runs automatically for pull requests. Its workflow
and required check are both named `PR Gate`; it runs lint, type checks,
migrations, and the test suite. A passing gate is the repository's automated
correctness signal. Native GitHub squash auto-merge may merge the pull request
after repository settings require that check.

AI coding agents may create branches, commits, Issues, and pull requests only
when explicitly assigned that work. They must not submit code reviews, approve
or block a pull request, request reviewers, or post unsolicited comments. They
may answer in an Issue or pull request only when explicitly mentioned and
asked a direct question.

## Product safety boundaries

These constraints apply to product runtime behavior:

- Agent-facing results preserve provenance:
  `{source_entity_ids, source_event_ids, method, confidence}`.
- Types marked `x-sensitive: true` remain unavailable through the generic
  agent-tool surface.
- Outward-facing bill actions remain draft-only until the product's explicit
  human approval flow creates an `authority_receipt` bound to the exact
  draft hash. This is a LifeOS runtime safety feature.
- Money ingestion never initiates transfers or payments.
- Domain access remains narrow; do not replace scoped contexts with
  `AccessContext.all()`.

Project invariants are in `.agents/invariants.md`; domain-specific data,
access, and safety contracts are in `.agents/domains/`. Product architecture decisions live in `docs/adr/`.
