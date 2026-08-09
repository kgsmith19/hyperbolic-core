# lifeos

Personal Life OS: domain-agnostic kernel (typed entity graph + append-only event log)
on Supabase; life domains plug in as data, not schema.

Stack: Python 3.12, FastAPI, Pydantic v2, Supabase (Postgres + pgvector), pytest, ruff, mypy.

Standard: [agent-engineering-standard](https://github.com/kgsmith19/agent-engineering-standard),
pinned in `.agent/standard.lock`. Repo-specific commands/facts live in
`.agent/project.yaml` — this file is the prose map, that one is the machine
copy; keep them in agreement.

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
  `execution_receipt` and only `ok` exits 0 (ADR 014, docs/runbook.md). The
  briefing is the INT1 morning digest (focus intentions, then calendar, then
  nothing else; Mondays add utility-gate status); an existing database needs
  `scripts/migrate_briefing_composition.py` once before the first recomposed
  run.
- import: `.venv\Scripts\python -m domains.intentions.import_priorities <path>` —
  operator-run, not scheduled: reads a priority list from a LOCAL text file
  (one item per line; the file never enters the repo), asks Anthropic to
  propose kind/next_action, and seeds FLAGGED `status: "candidate"` intentions
  the operator confirms via the capture UI. Idempotent: existing titles are
  skipped before anything is sent. Same receipt contract.
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
- Runtime-affecting PRs run lint, types, migrations, and the full suite in CI.
  Documentation/governance-only PRs use the CI fast path: they still run
  cell-scope enforcement and the required `PR Gate`, but do not start Postgres
  or execute the runtime suite. Merge only on green.
- Tests are lean too: assert behavior, not implementation; one concern per
  test; reuse conftest fixtures.
- The web UI lives in the sibling `lifeos-ui` repo; its Playwright e2e gate
  runs in that repo's CI (this repo's CI stays lint/types/migrations/pytest).

Work: GitHub Issues are the durable work-item source for new work
(`.github/ISSUE_TEMPLATE/work-item.md`); raw ideas are not work items until
they clear outcome + acceptance criteria. `docs/roadmap.md` remains the living
slice-queue/spec source it already was — this migration does not fold it into
Issues, since it is actively maintained (updated every slice PR) and doing so
would be a process rewrite, not a lean migration. One thin slice at a time, in
a short-lived branch. Define a slice's evidence before writing it — a
meaningful failing test (RED) before the minimum change that turns it green,
when a failing test is possible; coverage is a diagnostic signal, not the
goal. Code without its evidence passing is not done.

Agent risk & autonomy (distinct from the product's ADR 018 approval/authority
feature below — this is about what an implementing agent may do
unsupervised): R0 (non-behavioral) through R2 (normal product/API change)
proceed autonomously once the gate is green. R3 (auth, PII, secrets,
migrations, deploy config, anything under `.agent/project.yaml`'s
`protected_paths`) wants a human look before merge in addition to the gate;
R4 (destructive/financial/irreversible) needs explicit authorization beyond
that. An agent may raise a slice's declared risk, never lower it, and must not
change the checks, ruleset, or this risk policy in the same run that does
product work — that is a separately authorized change.

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

**Cell-scope enforcement (ADR 020):** the local machine hook still blocks an
edit before it happens when `.agents/task.json` declares the wrong cell. For
GitHub-hosted/headless work, the required PR Gate independently checks the PR
diff against the `Owns:` paths in both the base and head constitutions. Any PR
touching cell-owned paths must list exactly those cells in its PR body, e.g.
`Cells: bills` or `Cells: kernel, bills`; unowned-only changes need no cell.
The base+head union prevents a PR from weakening its own scope by narrowing an
ownership declaration in the same change.

Roadmap: `docs/roadmap.md` (living slice queue + prompts; updated every slice PR).
Context: `docs/research/lifeos-research-final.md` (v2 synthesis) and
`docs/research/lifeos-research-2026-07-29.md` (v3 synthesis, behind the
2026-07-29 queue revision and ADR 019) — both point-in-time snapshots, ADRs win
on conflict — and `docs/golden-questions.md` (behavior-scored grounding
regression bar; check-in questions runnable now, calendar questions once real
feed data exists).
