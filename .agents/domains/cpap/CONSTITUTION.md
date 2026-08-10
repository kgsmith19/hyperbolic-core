# cpap cell

Owns: `src/domains/cpap/**`, `tests/cpap/**`.

## Purpose

H2 slice: pull CPAP usage sessions from the SleepHQ public API v1
(client-credentials OAuth2) and expose one deterministic rolling 30-day
compliance result to the briefing (`domains.ops.briefing`). ez Share SD-card
pull is the roadmap's documented fallback source — **not implemented in code
this slice** (the roadmap's own pre-made decision is "no EDF parsing", and an
ez Share export is EDF; an operator without SleepHQ falls back to the SD card
manually, outside this system, until a future slice changes that). The
`lab_log` registry rider (roadmap §H2) also lands here: a type only, no
ingestion code, no briefing consumer — see "lab_log" below.

## Types

- **cpap_session** — one night's therapy data: `session_date` (identity,
  `YYYY-MM-DD`) and `source` are required; `usage_min`, `ahi`, `leak_95p`,
  `pressure_95p` and `central_ahi` are optional in the schema, all `x-pii`
  (health data about a diagnosed condition, invariant 9) and so deliberately
  **not** required — the calendar `title` precedent: forget() removes them,
  and an erased night must still be capturable on the next ingest pull. A
  reading SleepHQ has no value for (the four clinical fields) simply carries
  no key, never a fabricated zero. `session_date` is the identity key and
  therefore never PII (the identity-is-never-PII rule, ADR 012), so an
  erased night's date remains findable and the next ingest run updates it
  instead of minting a duplicate.
- **cpap_source_receipt** — hash-plus-metadata receipt of one SleepHQ pull
  (`cpap_receipt_key` identity, `sha256` over the normalized response,
  `window_start`/`window_end`, `session_count`). Never the verbatim API
  response body — that is the source's own PHI-shaped payload and cannot be
  erased per-subject (invariant 9, the calendar `source_receipt` precedent).
  Every `cpap_session` a pull writes or updates links to its receipt via a
  `derived_from` edge carrying `{method, confidence}` (ADR 010), exactly the
  calendar ingestion pattern.
- **lab_log** — operator-tracked lab draws: `lab_key` (identity, sha256 of
  `lab_name`+`date` — a hash, not the values, so an erased entry survives
  `forget()` findable, the bills `bill_key` precedent), `lab_name`, `date`,
  optional `cadence_days`. `lab_name`, `date` and `cadence_days` are `x-pii`.
  `domains.cpap.lab_log.next_due` is a pure function over a lab's own logged
  entries; nothing schedules or pushes it (no notification path — see below).

Identity field names (`session_date`, `cpap_receipt_key`, `lab_key`) are
chosen to not collide with any identity field name declared by another
domain: `ExactIdentityResolver` matches on field *name* across every type
that declares it, so reusing another domain's identity field name would let
a cpap capture resolve onto — or be resolved onto by — an unrelated entity.

## Credentials

`LIFEOS_SLEEPHQ_CLIENT_ID` / `LIFEOS_SLEEPHQ_CLIENT_SECRET` (OAuth2
client-credentials), read via `kernel.env.read_env` — the same convention as
`LIFEOS_HC_SECRET` and `ANTHROPIC_API_KEY`. Provisioned through the guards
vault, never hardcoded, never logged, never placed in an event payload, an
execution receipt, or an exception message that reaches stdout/stderr (a
provider error can echo request contents, so network failures are recorded
by exception *class name only*, the bills/calendar precedent). Optional
`LIFEOS_SLEEPHQ_BASE_URL` overrides the API host for testing; defaults to
`https://sleephq.com`.

**Missing credentials are a `skipped` execution receipt, never a crash and
never a silent no-op** (ADR 014, the calendar `LIFEOS_ICS_URLS`-unset
precedent): `domains.cpap.ingest.main` checks for both env vars before
touching the network, and if either is absent it returns
`JobResult(status=STATUS_SKIPPED, ...)` — a fact the scheduler and
`find(ctx, type_name="execution_receipt")` can see, not nothing happening
quietly. A configured-but-failing SleepHQ call (auth rejected, network down)
is `STATUS_FAILED` instead — an honest distinction between "we didn't try"
and "we tried and it broke."

## Idempotency Contract

Two layers, mirroring `domains.calendar.ingest`:

1. **Receipt short-circuit.** `cpap_receipt_key` hashes the normalized raw
   response plus the pull window; an unchanged response for the same window
   emits nothing beyond finding the existing receipt.
2. **Per-night dedup inside a changed pull.** Even when the response changed,
   each parsed night is compared against its stored `cpap_session` (by
   `session_date`) before writing; an unchanged night emits no
   `entity.updated` and no new `derived_from` edge. A changed night never
   writes back a field `forget()` has redacted on that entity (durable
   erasure, ADR 012).

## Compliance Service (`domains.cpap.compliance`)

Pure, deterministic, zero LLM (roadmap §H2, ADR 019 rule 1) — no participant
of any kind computes the compliance boolean or the nightly counts. Rolling
30-consecutive-calendar-day window ending at `as_of`, fixed 30-night
denominator (a night with no session on record counts as non-compliant, not
as excluded — the DME-style rule's own definition): nights ≥4h, nights ≥8h,
percent-of-nights ≥4h, a DME-style `compliant` boolean (≥4h on ≥70% of
nights, compared as an exact `fractions.Fraction` — never a float threshold
comparison, so a boundary night is never miscounted by floating-point
rounding), and `current_streak_nights` / `full_month_streak` (an unbroken run
of nights with `usage_min > 0` ending at `as_of`, capped by the window itself
— 30 only when every night in the window has usage). No prediction, no
interpretation copy, no clinical advice — the roadmap's pre-made decisions,
verbatim.

`compliance_for_briefing` returns `None` when a given day's 30-night window
has **zero** nights of session data — window-scoped exactly like the EP1
episodes line — never a fabricated zero-compliance result for a source that
has reported nothing near this date (the acceptance criterion: missing
source data is an explicit absence, not fabricated data). A partial window
(some nights missing, most present) still returns a result; the
missing-night count is carried honestly in `nights_missing`, which is not
fabrication.

## Briefing Integration

`domains.ops.briefing.assemble` calls `compliance_for_briefing` and, when it
returns a result, adds an optional `cpap_compliance` key to the briefing's
attributes (schema in `domains.ops.types.BRIEFING_SCHEMA`, guarded by
`additionalProperties: false` like every other section) and cites the
`cpap_session` entities the result was computed from — the existing
service/domain seam every other briefing section already uses
(`_optional_find`, the ADR 010 provenance envelope). No new framework: this
is the same optional-key pattern `episodes_line` and `gate` already
established. `briefing_context()` gains `cpap:read`; the briefing still holds
no write scope on anything it reads.

## Access Control

`cpap_context()` = `AccessContext.of("cpap:read", "cpap:write", "ops:read",
"ops:write")` — narrow by construction, never `AccessContext.all()` (ADR
012/014 precedent). The ingestion job runs inside `ops.receipts.run_job`, so
every run leaves an `execution_receipt` and only `ok` exits 0.

## Constraints (roadmap §H2 pre-made decisions, verbatim)

No EDF parsing, no myAir, no pressure suggestions, no prediction, no
interpretation copy anywhere. Zero kernel DDL (invariant 1); all writes
through kernel application services (invariant 7).

## Risk

R3 — sensitive health data (a diagnosed condition and therapy adherence) plus
an external credentialed integration, the same risk class as C0/SimpleFIN.
`/security-review` runs before merge.

Behavior changes land with tests in `tests/cpap/` (unit for the compliance
boundary math and SleepHQ response parsing, integration for ingest + the
briefing seam).
