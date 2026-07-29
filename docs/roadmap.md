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
  2026-07-28 (PR #23); acceptance complete same day: Claude Desktop over the
  server scored golden questions Q8/9/13/14 at their behavior bars (all pass,
  first baseline)
- [x] A2 Grounded chat with citations (ADR-011) — done 2026-07-28
  (lifeos + lifeos-ui slice-2 PRs); golden-question scoring recorded below
  on deploy
  A2 acceptance 2026-07-28: golden Q8/9/13/14 pass behavior bars with
  citations via /chat; latency p95 bar pending prod measurement — documented
  lever is LIFEOS_CHAT_MODEL=claude-sonnet-5 (config, no code).
- [x] A2.5 Daily check-in micro-slice (wellbeing `daily_checkin` type + capture
  form; starts the 14-day capture-sustainability experiment) — done 2026-07-28
  (PR #35): type is pure registry data via `scripts/define_daily_checkin.py`,
  zero UI changes (schema-driven Capture form renders it)

### B — Tomorrow Cockpit
- [x] B1 ICS calendar ingestion with source receipts (ADR-012) — done
  2026-07-28 (PR #36): calendar domain as registry data + src/domains/calendar/
  CLI ingestion, idempotent by VEVENT hash, raw-feed source receipts linked via
  derived_from edges; golden Q1 acceptance runs through chat on deploy
- [x] B2 Zero-LLM auto-link (exact/alias match vs identity spine → typed edge
  events + dedup-review queue) — done 2026-07-28 (PR #37): deterministic
  `python -m domains.calendar.autolink`; exact normalized email only (Google
  dot/plus aliases, not generalized), one candidate → `is_person` edge with the
  ADR-010 envelope, 2+ or conflicting → `link_review` item, none → nothing;
  edges only, the identity spine is never rewritten (ADR-013)
- [x] B3 Daily briefing cron + execution receipts + trigger_feedback — done
  2026-07-29 (PR #38, ADR-014): `ops` domain with a zero-LLM assembled
  briefing (cites entity ids, copies no third-party text), reusable
  execution receipts on every scheduled CLI (a failed run still receipts
  and exits non-zero), and `trigger_feedback` for a human verdict. The
  schedule itself is NOT installed: it is a guards runbox script
  (`install-lifeos-cron.ps1`) awaiting the operator, and needs vault key
  `LIFEOS_DEPLOY_HOST` plus a tailnet ACL rule for a non-CI device.
  Ingestion also stays inert until `LIFEOS_ICS_URLS` is set (it receipts
  `skipped` — visible, not silent), so golden Q1 is not yet runnable.
- [x] B4 `/tomorrow` page (lifeos-ui) — done 2026-07-29 (lifeos-ui PR #7): the
  Tomorrow Cockpit resolves the briefing's cited entity IDs at read time
  through the existing `/entities/{id}` route, so no display text is copied out
  of the entities that own it (ADR 014) and no API surface was added; an id
  that no longer resolves renders as gone, and `link_review` items still show
  as "needs your decision" with no resolve action (ADR 013)

### C — Bills v1 (first verified write path)
- [x] C1 Document capture (upload → storage ref → extracted text → sha256
  document event) — done 2026-07-29 (PR #43, ADR-015): `documents` domain with
  a `document` type keyed on the content sha256. Bytes and extracted text live
  in a content-addressed filesystem blob store (`LIFEOS_BLOB_ROOT`, the
  `lifeos-blobs` compose volume), never in `entity.attributes` — attributes are
  tsvector-indexed and erased only per entity, so a bill's text there would be
  searchable by anything with read scope and un-erasable in practice.
  `POST /documents` takes a multipart upload under the normal owner auth, caps
  at 10 MiB before the body is parsed, sniffs the MIME from magic bytes, and
  extracts PDF text with pymupdf → pdfplumber, recording a failure rather than
  crashing. Re-uploading the same bytes resolves to the same document and emits
  zero events; `POST /entities/{id}/forget` on a document also unlinks its
  blobs and leaves an `erased_at` tombstone, so a re-upload of erased bytes is
  refused (409) instead of silently reinstated. No LLM and no bill parsing —
  C2 owns those, and the deferred `x-sensitive` decision.
- [x] C2 Generic bill/obligation types + medical instance (x-sensitive from day
  one) + LLM extraction to flagged candidate events — done 2026-07-29
  (PR #44, ADR-016): `bills` domain with a GENERIC `bill` (discriminated by
  `category`, so a utility bill needs no new type), the medical `eob` instance
  beside it, and `bill_extraction` — the per-document record of which document's
  text went to which model, when. `python -m domains.bills.extract` reads a
  captured document's text through the documents domain, asks Anthropic under a
  JSON schema (structured outputs, refusal fallback, model via
  `LIFEOS_EXTRACT_MODEL`), and captures CANDIDATES: `status` is a one-value enum,
  provenance carries `method: "llm_extraction"`, and the schema itself refuses
  confidence 1.0, so nothing here can look like a verified fact — C3 owns that.
  Keys are hashes, never `claim_no`/`account_ref` (ADR 012 durable erasure), no
  free-text field exists in the domain, and the document text reaches Anthropic
  and nothing else: not the log, not an exception message, not an attribute.
  `x-sensitive` is **defined and enforced** rather than deferred again: a
  flagged type is withheld from the shared agent-tool surface, so bills never
  reach a model through a generic read tool (enforcement is domain-shaped).
  Write scope is checked before the text leaves the box.
- [x] C3 Deterministic reconciliation verifier + verification_receipts — done
  2026-07-29 (PR #45, ADR-017): `python -m domains.bills.verify` with **no
  model anywhere in the path** — nine deterministic checks over one document's
  candidates (line items sum to the total; the EOB identity `plan_paid +
  patient_resp == allowed` and `allowed <= billed` per line; non-negative
  amounts; coherent dates; duplicate line items across the document's
  candidates; one currency; nothing left flagged `low_confidence`; and a bill
  and its EOB agreeing on what the patient owes), each reported independently,
  money compared as `Decimal` within an explicit one-cent tolerance. A
  `verification_receipt` per document carries entity ids, check verdicts, line
  indices and *differences* — never a value copied from the document — and may
  honestly claim `confidence: 1.0` because it is arithmetic over kernel state.
  `status` earned its second member: `verified` is granted only when every
  check on a candidate passes, and it is protected three ways — the type
  refuses `verified` unless the record cites the receipt that granted it,
  `POST /capture` dispatches to a domain guard keyed on the record a capture
  would LAND on (entity resolution matches identity fields by name across types,
  so a payload carrying a bills identity key must be a capture of the type that
  owns it; receipts and extraction records are not route-writable at all), and
  every run re-judges what it promoted so anything that stops passing is
  demoted. Erasing a candidate cascades to its receipts synchronously through
  the same `/forget` endpoint, because a delta equals an amount whenever the
  other operand is zero. Zero kernel changes; existing databases need
  `scripts/migrate_bill_status_verified.py` once (the registry has no
  redefinition path).
- [x] C4 Approval-gated dispute draft (action_proposal → approval mints
  authority_receipt; terminates at an approved on-screen draft) — done
  2026-07-29 (PR #48, ADR-018): `python -m domains.bills.dispute` turns a
  FAILED verification receipt into a `proposed` `action_proposal`, and nothing
  else in the system can act on it. **The draft body is never stored**: the
  proposal holds ids, check enum names and one count, and the letter is
  rendered on demand from the candidates it cites (`render_draft`), because a
  dispute letter in a searchable attribute is the B1/C1/C2 finding a fourth
  time — so erasing a candidate empties the draft by construction rather than
  by a cascade nothing schedules. Only failures where the DOCUMENT disagrees
  with itself become points; `unchecked` never does, and everything not stated
  is counted on the record and named in the letter, so "my records could not
  read this" can never read as "you overcharged me". Approval is an explicit
  `POST .../approve` that must echo the sha256 of the exact draft it read, mints
  an `authority_receipt` recording who/when/what/until-when, and takes
  `granted_by` from the verified request rather than the body. The gate
  (`emit_draft`) refuses without a valid, matching, unexpired receipt whose
  grant actually permits this act on a channel this system can serve, and
  records nothing when it refuses — and it is the ONLY reader of a decided
  proposal's letter, since the listing renders one only while it is `proposed`
  (a state nothing returns to), so the gate has no ungated twin. Minting
  authority needs the owner's own unrestricted session, and `granted_by` /
  `granted_via` come from the claims verified for that request rather than from
  configuration. **Invariant 8: the leg this whole path lacks is (b) external
  communication** — no transport exists, and the authority type's
  `permits`/`channel` are one-member enums, so a grant to send is not
  expressible without a schema change, a migration and an ADR. Zero kernel
  changes; existing databases need `scripts/migrate_bill_date_charset.py` once
  (C4 made `service_date` prose in an outward-facing letter, so it is now
  bounded by character class as well as length).
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
- Approval/authority receipts — landed C4 (ADR 018): `action_proposal` +
  `authority_receipt`, minted only by an explicit human approval bound to the
  digest of the draft that was read, with a gate that refuses to emit without
  one. Nothing can be sent: `permits`/`channel` are one-member enums.
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
render. Adjudicate gateway-vs-direct in ADR-011. Re-checked in C2 (ADR-016):
bill extraction is the second LLM consumer, but it shares the key, the client
construction and the process, so it is not the "second consumer" ADR 009's
extraction rule is about. The LiteLLM trigger stands at a real budget,
usage-tracking or multi-provider need.

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
