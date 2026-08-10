# Roadmap

Living document — the canonical slice queue and historical record. Every slice
PR updates its status line here. ADRs win on conflict. Background:
`docs/research/lifeos-research-final.md` (v2 synthesis, point-in-time) and
`docs/research/lifeos-research-2026-07-29.md` (v3 synthesis — the second
research pass behind the 2026-07-29 queue revision). The full evidence base
behind v3 lives in working files outside git, in the ecosystem `notes/` folder
(`notes/NEXT-DIRECTION-RESEARCH-2026-07-29.md`,
`notes/ROADMAP-PROPOSAL-2026-07-29.md`);
cite them by name, never copy their content here.

Milestones are product moments; each slice is one focused Claude Code session,
launched from the repo being changed, branch + PR, merge on green. Kickoff:
paste the slice prompt below into a fresh session, or say "run slice N".
Pre-made decisions in prompts are not relitigated. Event-triggered entries
start on their trigger, never on their turn.

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

### A — Grounded answers (SHIPPED)
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

### B — Tomorrow Cockpit (SHIPPED)
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

### C — Bills v1 (SHIPPED through C4; the rest is event-triggered)
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
- [x] Milestone-C boundary fixes — done 2026-07-29 (PR #49 review must-fixes,
  PR #50 `run-scheduled-jobs` on-demand execution of the nightly trio)
- C5 Branch-explore — moved to the event-triggered list below (unchanged gate:
  only on a real ambiguous case in actual bills)

### The committed queue (2026-07-29 revision; in order)

Reconciled from the second research pass (see Background). Operator-fit design
rules for everything below: ADR-019. Committed set ends at D1; the utility
gate bounds everything after it.

- [x] INT1 Intentions in the cockpit — intention type + priority-list import +
  focus-3 rule (service-enforced max 3 focus), briefing *recomposition* on the
  existing ops briefing (ADR-014; composition spec in the prompt), and the
  check-in rider fields the briefing consumes (1-tap practice completions,
  appreciation-expressed, phone-free-block-kept, caffeine mg + last-cup-time,
  no-dairy kept — define script, zero code). Display-only: no triggers, no
  scheduler (E1 owns those). Prompt §INT1 below. — done 2026-07-29 (PR #53;
  existing databases run `scripts/migrate_briefing_composition.py` once, and
  re-run `scripts/define_daily_checkin.py` for the rider fields)
- [ ] H1 Health Connect webhook (Android) — weight + activity + workouts pushed
  from the phone's Health Connect store to a tailnet-only endpoint.
  **/security-review pre-merge** (first inbound webhook). Operator pre-req: the
  Health Connect Webhook app installed and pointed at the endpoint (Tailscale
  already installed), and at least one source writing into Health Connect — a
  Withings scale for weight (its Health Mate app has first-class Health Connect
  support; it is also D1's only weight input) and the phone's own Fitbit app for
  steps/activity. Prompt §H1 below.
- [x] H2 CPAP ingestion + rolling compliance service — SleepHQ public API v1
  (ez Share SD pull remains the documented, not-yet-implemented fallback:
  the pre-made "no EDF parsing" decision rules out coding it this slice) →
  cpap_session events + one deterministic 30-day compliance service
  (`domains.cpap.compliance`, exact-Fraction threshold math, zero LLM)
  feeding the briefing via the existing optional-key seam. Operator pre-req:
  SleepHQ account; `LIFEOS_SLEEPHQ_CLIENT_ID`/`_SECRET` via the guards vault,
  never chat; missing credentials are a `skipped` execution receipt, never a
  crash. Registry rider: `lab_log` type (operator-tracked labs; next-due from
  cadence config, `domains.cpap.lab_log.next_due`) lands here as a type only —
  no ingestion code, no briefing consumer. Prompt §H2 below. — done 2026-08-10
  (PR #98; existing databases run `scripts/migrate_briefing_composition.py`
  once for `cpap_compliance`).
- [x] EP1 Episode support — episode + playbook types (**x-sensitive from the
  first migration**), deterministic evidence-card service, chat/briefing lines.
  Pull-only; no notification path may exist in code. Prompt §EP1 below.
- [ ] C0 Transaction ingestion — SimpleFIN Bridge access-URL pull
  (user-triggered CLI, never a daemon) + bank-CSV import.
  **/security-review pre-merge MANDATORY** (financial data). Operator pre-req:
  SimpleFIN Bridge account; access-URL via the guards vault, never stored or
  logged. Prompt §C0 below.
- [ ] C0.5 Recurring charges + pay periods — deterministic detector, review
  queue, pay_period windows from paycheck deposits. Rider: months-of-cover
  (weekly review only). Prompt §C0.5 below.
- [ ] D1 Adherence rollup pack — EWMA weight trend with %/week bands, weekly
  quota scoring with freezes and a repair window, lapse-resume gap summary.
  Registry rider: elimination_window type (its comparison rollup is the
  consumer). Prompt §D1 below.

Order rationale (one line each): INT1 first because the briefing is thin
without intentions and everything downstream reads them; H before C because the
current season is health-primary and H2 concentrates three needs at once
(personal goal + DME billing math + call prep); EP1 after H2 so perturbation
flags have CPAP data behind them; C0/C0.5 immediately after because they are
days-scale and power the weekly money block; D1 as soon as H data flows.

### Event-triggered (never scheduled)

These start on their trigger, not on their turn — a trigger firing outranks
the committed queue's tail.

- [ ] C2b DME rental ledger — rider on the shipped C2 types: payments vs
  13-month cap vs cash price vs compliance status, fed by H2.
  TRIGGER: first real bill / EOB / DME statement arrives.
- [ ] C4b Call-script packs — rider on the shipped C4 machinery: the approval
  gate produces a call-script pack alongside (or instead of) a dispute letter.
  TRIGGER: first real bill / EOB / DME statement arrives.
- [ ] C5 Branch-explore — TRIGGER: a real ambiguous case appears in actual
  bills (unchanged gate).
- [ ] D2 Memory that compounds — summaries with supersede chains → hybrid
  retrieval (derived content only) → `as_of` / `what_changed` / compare-period
  rollups (the original D scope minus health ingestion, which moved to H;
  embedding/retrieval decisions follow the v2 research adjudications).
  TRIGGER: two-plus domains have months of data.

### UTILITY GATE (standing, from here down)

Nothing below starts until check-in + briefing + weekly review show **≥5
days/wk use for 4 consecutive weeks**, computed from kernel data (the briefing
can report gate status itself). ADR-019 rule 9. F is additionally gated on its
own triggers, as ever.

### E — Prospective copilot (post-gate; anything that writes is also post-C4,
which has shipped — write verbs reuse its machinery)
- [ ] E1 Intention triggers/reminders (deterministic, display-only) + chat
  verbs decompose / prep / eval-prep upgraded from draft-text to one-click
  approval-writes via the C4 action_proposal → authority_receipt machinery +
  initiate with scheduled check-back
- [ ] E2 Relationship copilot (own-behavior only; other people appear as
  untyped name strings; draft-never-send) + PWA + share target + quick capture
  (rider: voice dictation via VPS ASR → proposed entity)

### F — Instrumentation (gated, not scheduled)
- [ ] Trace ingestion/search — gate: a recurring failure pattern documented ≥3×
- [ ] Capability trials — gate: ~20 capabilities or first observed skill
  regression
- [ ] Offline PR-only lab — gate: all of the above exist

### Queue end

- [ ] Full ecosystem `/lean-review` + one system-wide `/security-review` —
  runs when the committed queue is empty, before the utility gate opens
  anything new.

## Mechanisms and where they land

- Provenance payload `{source_event_ids, method, confidence}` — schema-enforced
  from A1 tool outputs and every derived event after.
- Execution receipts + trigger_feedback — with the first cron job (B3).
- `as_of` threading, `what_changed`, `superseded_by` chains — D2 (event-
  triggered).
- Approval/authority receipts — landed C4 (ADR 018): `action_proposal` +
  `authority_receipt`, minted only by an explicit human approval bound to the
  digest of the draft that was read, with a gate that refuses to emit without
  one. Nothing can be sent: `permits`/`channel` are one-member enums.
- Operator-fit rules (push/pull split, quotas-not-streaks, focus-3,
  code-computes-model-narrates, utility gate) — ADR-019, binding on every
  slice from INT1 on.
- Drop-and-rebuild determinism — a standing test, not a daemon.
- Golden questions (`docs/golden-questions.md`) — the living regression suite;
  grows every slice.

## Anti-deltas (standing)

No second graph substrate; no external memory framework as runtime; no
per-domain services/APIs; no second task manager; no ambient always-on capture;
no multi-tenant anything. Proactivity ceiling until the prospective-copilot
milestone: watch / summarize / remind / draft only.

Deliberately not doing (2026-07-29 additions, one line each; rationale in the
v3 research file §4):

- No prediction or risk scoring of mood, episodes, or relationship outcomes;
  no "detected" alerts; no live physiology dashboards.
- No symptom-shaped push notifications of any kind — plans may be pushed;
  feelings are pull-only.
- No unlimited reassurance chat: repeated same-day wellbeing queries return
  the playbook verbatim, never fresh generated comfort.
- No high-frequency in-episode prompting; no emoji-only mood scores.
- No fields modeling another person's state, no relationship scores or ratio
  counters, no model-drafted intimate or apologetic messages, no mid-conflict
  coaching.
- No absolute-delta goal lines for trending quantities, no formula anchored to
  the wrong quantity, no nutrient database or barcode scanner, no
  medical-advice engine, no device write-back.
- No auto-apply bots, resume optimizers, job-search CRMs, or
  application-volume tooling.
- No business infrastructure ahead of a first paying client.
- No exposure-coaching that initiates exercises — compile drafts for the
  clinician only.

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

Prompts for the committed queue, copied verbatim from the 2026-07-29 proposal
(authored against a pre-C1 snapshot; slice names in prompt headers are the
proposal's — the mapping note above each block is authoritative). Prompts for
event-triggered entries and E1/E2 are authored when those come due.

### INT1 — intention type + import + briefing recomposition

Authored as "B2.5" plus a "B3 addendum" before C1-C4 shipped. B3 is live
(PR #38, ADR-014), so the composition block below applies as a
*recomposition* of the existing ops briefing, and the check-in rider fields
land in this slice via define script (the recomposed briefing is their
consumer).

```
# lifeos Slice B2.5: intention type + priority-list import (display-only)
Registry-only domain rows + one service rule. intention type (title,
kind: task|project|habit_quota|research_errand|recurring_commitment,
status, focus bool, floor string nullable, next_action, source).
Service enforces max 3 focus=true (reject the 4th). Import script seeds
the operator's current priority list; LLM-proposed kind/next_action land
as FLAGGED candidate events, operator confirms via existing capture UI.
Pre-made decisions: no triggers, no scheduler, no recurrence, no
completion analytics (E1 owns all of those); floors are plain strings.
Acceptance: CI green; import idempotent; golden Qs "What are my 3 focus
goals?" and "What is the floor version of <habit>?" pass with citations;
4th-focus rejection is a service test.
```

```
Briefing composition (pre-made decisions for the B3 prompt):
ONE morning digest. Order: 3 focus intentions with floors and next
physical actions (restart-neutral copy; never overdue counts), calendar
context, then nothing else until data exists (compliance calendar joins
after H2; co-occurrence line after EP1; talking points after H2 rider).
Plans may be pushed; feelings are pull-only: no mood/symptom prompts in
any notification path. Weekly edition adds: quota scores, months-of-
cover (after C0.5 rider), gate status. Check-in registry riders (1-tap
practices, appreciation, phone-free, caffeine mg/last-cup, no-dairy)
land here via define script since the briefing consumes them.
```

### H1 — Health Connect webhook (Android)

Re-authored 2026-07-30: the original prompt named Health Auto Export, which
reads Apple HealthKit and does not exist on Android. The operator is on a
Pixel, so the source is now the **Health Connect Webhook** app
(`com.hcwebhook.app`, open source at `mcnaveen/health-connect-webhook`), which
reads Google Health Connect on-device and POSTs to an arbitrary URL. Health
Connect has no cloud API by design, so an on-device pusher is the only path.
The endpoint's security posture and the types are unchanged from the original.

```
# lifeos Slice H1: Health Connect ingestion (Android webhook push)
Tailnet-only FastAPI endpoint receiving pushes from the Health Connect
Webhook Android app (phone on Tailscale). Types: weight_measurement,
activity_summary; workout extends existing type. Receipts sha256+
metadata; schema-validated, additionalProperties false, size caps,
shared-secret header (the app sets custom headers per webhook URL;
rotation documented). ADR-012 hostile-input rules apply.
/security-review pre-merge MANDATORY (first inbound webhook): the app
provides no signature or built-in auth, so that header plus the tailnet
are the entire perimeter.

Payload: ONE JSON object per delivery, with `timestamp` and
`app_version` at the root plus optional snake_case arrays per data type
(absent when empty). `weight` items are {kilograms, time} — weight
arrives in KILOGRAMS, fixed by the source; convert on read, never
mutate at the edge. `exercise` items are {type, start_time, end_time,
duration_seconds, distance_meters?, steps?, avg_cadence_spm?,
max_cadence_spm?, stride_length_m?}. Ignore unknown arrays rather than
rejecting the delivery; reject unknown FIELDS within a known array.

Idempotency is the core of this slice, not a defence. The app carries
NO per-record id, reads a rolling 48-hour window, and retries failed
deliveries with backoff — so duplicate and overlapping delivery is the
normal case. Key each record on a content hash of (metric, timestamp,
value). Delivery cadence is app-side config (interval, fixed times, or
manual Sync Now); lifeos schedules nothing here (ADR-019 push/pull).
Pre-made decisions: no sleep_session (CPAP covers sleep signal); ONE
ingestion path (Health Connect) and no second cloud health API, whoever
the device vendor is; no trend math (D1 owns it); no charts.
Acceptance: CI green; replaying the SAME 48h window twice and then an
OVERLAPPING window emits zero duplicates; per-day weight answers with
citations; trend questions abstain pending D1.
```

### H2 — CPAP ingestion + rolling compliance

```
# lifeos Slice H2: CPAP usage ingestion + rolling compliance service
Source: SleepHQ public API v1 (client-credentials; ez Share SD pull is
the documented fallback) → cpap_session events (date, usage_min, AHI,
leak_95p, pressure_95p, central_ahi?). One deterministic service:
rolling 30-consecutive-day window → nights ≥4h and ≥8h, %-of-nights,
full-month streak status, DME-style compliance boolean (≥4h on ≥70% of
nights). Feeds briefing.
Pre-made decisions: no EDF parsing, no myAir, no pressure suggestions,
no prediction, no interpretation copy anywhere.
Acceptance: CI green; fixture months compute exactly; double-run
idempotent; golden Qs "How many of the last 30 nights ≥4h?", "Am I on
track for a full month?" pass with citations; "Will I have a bad night
tomorrow?" abstains.
Rider if time remains: config table {metric threshold → one clinician/
DME talking point} rendered as a briefing line (e.g., leak >24 L/min on
≥4 of 7 nights → cushion-fit conversation). Talking points only.
```

### EP1 — episode support (x-sensitive)

```
# lifeos Slice EP1: episode log + playbook + evidence card (pull-only)
Types (x-sensitive from first migration): episode (onset_date,
perturbation_tags[], intensity 0-10, function_impact bool,
feared_duration_days, end_date, retro_note) and playbook (owner-
authored versioned if-then steps). Daily in-episode intensity is a
plain entity update via existing capture; the append-only history IS
the time series (no new UI). One deterministic evidence-card service:
episode count, median/trend of durations, feared-vs-actual gap,
perturbation co-occurrence counts. Chat prompt lines: at episode open,
cite playbook verbatim + evidence card; repeated same-day wellbeing
queries return the playbook, never fresh reassurance. Briefing may show
ONE descriptive line ("2 of your usual perturbations present this
week"), historical language only.
Pre-made decisions: no prediction, no risk scores, no physiology
dashboards, no push prompts, no exposure coaching, no clinical advice;
playbook and episodes are operator-authored via capture, never
generated.
Acceptance: CI green; evidence card computes fixture ledgers exactly;
golden Qs "What does my playbook say?" (verbatim, cited), "How long did
episodes actually last vs feared?" (computed, cited), "Will I have an
episode next week?" (abstains); no notification path exists in code.
```

### C0 — transaction ingestion

```
# lifeos Slice C0: transaction ingestion with source receipts
New domain money as registry rows + src/domains/money/: transaction,
account. Sources: SimpleFIN Bridge access-URL pull (user-triggered CLI,
never a daemon) and bank-CSV import. Idempotent by (account,
posted_date, amount, normalized_desc) hash; receipts sha256+metadata
only (no verbatim statements). Access-URL is a bearer credential:
vault/env only, never stored or logged. ADR-012 same-host redirect rule
on outbound fetch. /security-review pre-merge MANDATORY.
Pre-made decisions: no recurring detection (C0.5), no budgets, no
documents, no auto-sync, no balances-forecasting.
Acceptance: CI green; double-run emits nothing new; per-date spend
queries answer with citations.
```

### C0.5 — recurring + pay periods

```
# lifeos Slice C0.5: recurring charges + pay-period windows (pure code)
Deterministic detector over transaction events: normalized merchant +
amount tolerance + cadence regularity (7/14/30/365 ± slack) →
recurring_charge entities with provenance; review queue, no auto-
cancel. pay_period derived from paycheck deposit events; spend and
recurring queries take a period parameter. No ML, no new deps.
Pre-made decisions: no envelopes, no forecasts, no cancellation
actions, no investment anything.
Acceptance: CI green; fixtures detect known subscriptions, zero false
merges; idempotent; golden Qs "What recurring charges hit last pay
period?", "What did I spend since my last paycheck?" pass with
citations.
Rider if time remains: months_of_cover = liquid balances ÷ one
operator-set essential-monthly-baseline config value; weekly review
only, never the daily briefing.
```

### D1 — adherence rollup pack

```
# lifeos Slice D1: deterministic adherence rollups
Three read services over H1/H2/check-in/intention data, model narrates:
(1) weight: EWMA trend + rolling %-of-current-weight/week vs bands
(green 0.5-1%/wk) + taper-expected annotation + goal ETA recompute;
never a fixed lb/wk goal line; protein anchor notes goal weight.
(2) quotas: weekly counts vs habit_quota intentions (lifting, walking,
practices) with 1-2 freezes and 24h repair window; no daily streaks.
(3) lapse-resume: on any ≥7-day capture gap, a welcome-back summary
(what happened in the gap, zero guilt, no backfill demand).
Pre-made decisions: every formula names its anchor; no causal language;
elimination_window type lands here via define script (its comparison
rollup is the consumer).
Acceptance: CI green; fixtures compute exactly; golden Qs "What is my
weight trend and is this pace expected?", "Did I hit my lifting quota
this week?", "What did I miss while away?" pass with citations.
```
