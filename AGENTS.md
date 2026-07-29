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
- mcp: `.venv\Scripts\python -m mcp_server` — read-only stdio MCP server for
  agent clients; needs a minted agent token (README "Agent access over MCP").
- jobs: `.venv\Scripts\python -m domains.calendar.ingest` / `.calendar.autolink` /
  `.ops.briefing` — the scheduled trio, run in that order; each leaves an
  `execution_receipt` and only `ok` exits 0 (ADR 014, docs/runbook.md).
- deploy: merge to main → GitHub Actions checks, builds, migrates, deploys (docs/runbook.md).
- review: `/lean-review` (five-lens codebase review; headless: `claude -p "/lean-review"`);
  `/diff-review` for just the working diff or current branch.

Engineering standards:
- Simplest solution that fully works; fewest lines that stay clear. Never
  trade functionality for brevity.
- Reuse before adding. No new abstraction, file, dependency, or layer without
  a present need; delete code a change makes dead.
- Idiomatic current-stack code (Python 3.12, FastAPI, Pydantic v2). ruff and
  mypy gate CI — keep them clean.
- Every behavior change ships with tests in the matching tier: unit (pure
  logic, no I/O), integration (service ↔ Postgres, `tests/kernel/`), e2e
  (HTTP → app → DB, `tests/api/`).
- CI runs lint, types, migrations, and the full suite on every PR. Merge only
  on green — there is no server-side branch protection; this rule is the gate.
- Tests are lean too: assert behavior, not implementation; one concern per
  test; reuse conftest fixtures.
- The web UI lives in the sibling `lifeos-ui` repo; its Playwright e2e gate
  runs in that repo's CI (this repo's CI stays lint/types/migrations/pytest).

Provenance convention (ADR 010): every agent-facing tool result carries
`{source_entity_ids, source_event_ids, method, confidence}`. Direct kernel
reads are confidence 1.0; anything derived — rollups, links, extractions, and
the events they emit — must cite the event ids it was built from, its method,
and an honest confidence.

Rules: `.agents/invariants.md` (project invariants), `.agents/domains/` (per-cell constitutions).

Roadmap: `docs/roadmap.md` (living slice queue + prompts; updated every slice PR).
Context: `docs/research/lifeos-research-final.md` (v2 synthesis, point-in-time
snapshot — ADRs win on conflict) and `docs/golden-questions.md` (behavior-scored
grounding regression bar; run after the chat and calendar slices).
