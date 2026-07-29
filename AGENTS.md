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
- extract: `.venv\Scripts\python -m domains.bills.extract [document_id ...]` —
  operator-run, not scheduled: it sends a captured document's text to Anthropic
  and captures candidate bills/EOBs (ADR 016). Same receipt contract.
- verify: `.venv\Scripts\python -m domains.bills.verify [document_id ...]` —
  the deterministic reconciliation pass over those candidates (ADR 017). No
  model, no network: it leaves a `verification_receipt` per document and
  promotes a candidate to `status: "verified"` only when every check passes.
  Same receipt contract. An existing database needs
  `scripts/migrate_bill_status_verified.py` once before the first run.
- dispute: `.venv\Scripts\python -m domains.bills.dispute [document_id ...]` —
  operator-run: turns a FAILED `verification_receipt` into a *proposed*
  `action_proposal` (ADR 018). It drafts and nothing else. **Nothing is sent
  and nothing here can send**: an approval (`POST
  /action-proposals/{id}/approve`, echoing the draft's sha256) mints an
  `authority_receipt`, and the gate refuses to emit a draft without a valid,
  matching, unexpired one. Same receipt contract. An existing database needs
  `scripts/migrate_bill_date_charset.py` once before the first run.
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

Sensitive types (ADR 016): a `type_definition` carrying `x-sensitive: true` is
withheld from the shared agent-tool surface, so its records never reach an LLM
through a generic read tool. Enforcement is domain-shaped (scopes are), so
flagging one type withholds every type in its domain — put sensitive types in a
domain of their own.

Approval and authority (ADR 018): nothing outward-facing happens without an
`authority_receipt`, which only an explicit human approval mints, bound to the
sha256 of the exact draft that was read. A component proposing an outward action
must name the invariant-8 leg it lacks (today: (b) external communication —
there is no transport in this repo outside `domains.bills.extract`'s Anthropic
call, and the grant's `permits`/`channel` are one-member enums so "send" is not
expressible).

Rules: `.agents/invariants.md` (project invariants), `.agents/domains/` (per-cell constitutions).

Roadmap: `docs/roadmap.md` (living slice queue + prompts; updated every slice PR).
Context: `docs/research/lifeos-research-final.md` (v2 synthesis, point-in-time
snapshot — ADRs win on conflict) and `docs/golden-questions.md` (behavior-scored
grounding regression bar; run after the chat and calendar slices).
