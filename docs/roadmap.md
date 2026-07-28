# Roadmap

Living document — the canonical slice queue and historical record. Every slice
PR updates its status line here. ADRs win on conflict. Background:
`docs/research/lifeos-research-final.md` (v2 synthesis, point-in-time) and the
v3 adjudication (2026-07-28): keep the kernel skeleton, harvest mechanisms into
small slices, reject mega-slices.

Milestones are product moments; each slice is one focused Claude Code session,
launched from the repo being changed, branch + PR, merge on green. Kickoff:
paste the slice prompt below into a fresh session, or say "run slice N".
Pre-made decisions in prompts are not relitigated.

## Repos & services

- `lifeos` — kernel + API (Python/FastAPI/Supabase). The only door to data is
  application services (ADR 006); agents get MCP wrappers over those services.
- `lifeos-ui` — SPA (React/Vite). All HTTP through `src/api/client.ts`,
  generated types via `gen:api`.
- New repos/deployables follow ADR 009: a new *deployable* only for an
  independent lifecycle or failure isolation; a new *repo* only on a second
  real consumer — extract on the second consumer, never on prediction. New
  capabilities are lifeos *domains* first (ADR 002): type definitions + data,
  no new repo. Planned extractions and triggers are listed in ADR 009 (auth
  package, platform repo, LiteLLM gateway, notifications).
- Agent tokens are scoped and fail-closed; re-mint on new domain.

## Milestones and slice queue

### A — Grounded answers
- [x] A1 Read-only MCP server + first scoped agent token (ADR-010) — done
  2026-07-28 (PR #23); operator steps: run the guards keygen runbox, mint a
  token, wire Claude Desktop (README), then score golden questions Q8/9/13/14
- [ ] A2 Grounded chat with citations (ADR-011)
- [ ] A2.5 Daily check-in micro-slice (wellbeing `daily_checkin` type + capture
  form; starts the 14-day capture-sustainability experiment)

### B — Tomorrow Cockpit
- [ ] B1 ICS calendar ingestion with source receipts (ADR-012)
- [ ] B2 Zero-LLM auto-link (exact/alias match vs identity spine → typed edge
  events + dedup-review queue)
- [ ] B3 Daily briefing cron + execution receipts + trigger_feedback
- [ ] B4 `/tomorrow` page (lifeos-ui)

### C — Bills v1 (first verified write path)
- [ ] C1 Document capture (upload → storage ref → extracted text → sha256
  document event)
- [ ] C2 Generic bill/obligation types + medical instance (x-sensitive from day
  one) + LLM extraction to flagged candidate events
- [ ] C3 Deterministic reconciliation verifier + verification_receipts
- [ ] C4 Approval-gated dispute draft (action_proposal → approval mints
  authority_receipt; terminates at an approved on-screen draft)
- [ ] C5 Branch-explore — only if a real ambiguous case appears in actual bills

### D — Memory that compounds
- [ ] Summaries with supersede chains → hybrid retrieval (derived content only)
  → `as_of` / `what_changed` / compare-period rollups → health ingestion

### E — Prospective copilot
- [ ] Intentions (deterministic triggers, display-only) → relationship copilot
  (draft-never-send) → PWA + share target + quick capture

### F — Instrumentation (gated, not scheduled)
- [ ] Trace ingestion/search — gate: a recurring failure pattern documented ≥3×
- [ ] Capability trials — gate: ~20 capabilities or first observed skill
  regression
- [ ] Offline PR-only lab — gate: all of the above exist

## Mechanisms and where they land

- Provenance payload `{source_event_ids, method, confidence}` — schema-enforced
  from A1 tool outputs and every derived event after.
- Execution receipts + trigger_feedback — with the first cron job (B3).
- `as_of` threading, `what_changed`, `superseded_by` chains — milestone D.
- Approval/authority receipts — first external-action slice (C4).
- Drop-and-rebuild determinism — a standing test, not a daemon.
- Golden questions (`docs/golden-questions.md`) — the living regression suite;
  grows every slice.

## Anti-deltas (standing)

No second graph substrate; no external memory framework as runtime; no
per-domain services/APIs; no second task manager; no ambient always-on capture;
no multi-tenant anything. Proactivity ceiling until the prospective-copilot
milestone: watch / summarize / remind / draft only.

Standing rule (record now, enters `.agents/invariants.md` when the first
optimizer exists): no optimizer may rewrite its own evaluator; nothing
self-promotes; verifiers are fixed at task start.

Open flag for A2/ADR-011: ADR 009 puts provider LLM keys in a LiteLLM gateway
at first LLM usage; pre-slice wiring put `ANTHROPIC_API_KEY` in the app `.env`
render. Adjudicate gateway-vs-direct in ADR-011.

## Slice prompts (queue)

### Slice 2 — A2 (+ A2.5 rider)

```
# lifeos Slice 2: grounded chat with citations (ADR-011)
Read AGENTS.md and the Slice 1 MCP/service seam; reuse it — the chat loop
calls the same read services/tools, never the DB.
Build: POST /chat (SSE) with a sidecar agent loop, read-only by scope-
stripping; structured tool outputs only; every factual answer cites the
entities/events used; abstains when data is absent. lifeos-ui chat page per
its AGENTS.md: all HTTP through src/api/client.ts, run gen:api and commit
types.gen.ts, unit + Playwright e2e (route-mocked to the API host).
Instrument latency; target p95 < ~4s over tailnet.
Deliverables: endpoint + SPA page + ADR-011 + tests both repos.
Acceptance: both CI gates green; runnable golden questions pass their
behavior bars with citations visible; an unanswerable question abstains.
Out of scope: writes, proactive anything, embeddings, calendar.
Micro-slice if time remains (else next session): wellbeing domain
daily_checkin type_definition (date identity key; mood/energy/stress/
sleep_quality 1-5; top_priorities; optional note) + existing capture form
wired — starts the 14-day capture-sustainability experiment.
```

### Slice 3 — B1

```
# lifeos Slice 3: ICS calendar ingestion with source receipts (ADR-012)
Read AGENTS.md and invariants; new domain = type_definition rows + module
under src/domains/, zero kernel DDL.
Build: read-only ICS pull from configured URLs; appointment/attendee types;
idempotent by VEVENT hash (re-runs emit nothing new); raw source receipt
stored and linked to every derived entity/event; ingestion runs under a
schedule-scoped token (fail-closed; re-mint per settled decision).
No auto-link pass in this slice — that is the next slice, on purpose.
Deliverables: ingestion service + types + ADR-012 + unit/integration tests
(fixture ICS files: recurrence, timezone, an updated event superseding).
Acceptance: CI green; double-run produces zero duplicates; golden question
Q1 (today's calendar, chronological) passes through chat with citations;
every calendar entity resolves to its source receipt.
Out of scope: Google OAuth, email enrichment, auto-link, briefing cron.
```
