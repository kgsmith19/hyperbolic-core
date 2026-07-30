# ADR 014: Scheduled jobs — the `ops` domain, execution receipts, assembled briefings

## Decision

**A new `ops` domain, not `wellbeing` and not `briefing`.** Three
`type_definition` rows — `execution_receipt`, `briefing`, `trigger_feedback`,
domain `ops` — plus a module `src/domains/ops/`; zero kernel DDL (invariant 1)
and no new deployable (ADR 009). The briefing summarizes calendar *and*
wellbeing, so it cannot live in either: `wellbeing:read` must not become a door
to calendar-derived content, and vice versa. A briefing is also not a fact about
the owner's wellbeing — it is a scheduled artifact whose lifecycle matches the
receipt that recorded its run and the feedback a human leaves on it. Naming the
domain `briefing` was rejected for the opposite reason: `execution_receipt` is
emitted by the calendar ingest and auto-link jobs too, and making
`domains.calendar.ingest` hold `briefing:write` would misdescribe what it does.
`ops` is what all three types are: the scheduler's own record of what ran, what
it produced, and whether it was worth producing.

**Execution receipts are the audit trail, one per run, always.** Every
scheduled entry point runs inside `ops.receipts.run_job`, which stamps
`started_at`, runs the work, stamps `finished_at`, and captures an
`execution_receipt` carrying `{job, started_at, finished_at, status, summary,
produced_entity_ids}` — on success *and* on failure. Status is exactly
`ok` (ran and completed), `failed` (raised, or reported partial failure) or
`skipped` (a precondition was absent — e.g. `LIFEOS_ICS_URLS` unset). Only `ok`
exits 0: a misconfigured job must never look to the scheduler like a quiet
"nothing to do". `run_job` defines the `ops` types before it runs the work, so a
job that fails on its first line still has a type to be receipted against; if
receipt capture itself fails the exception propagates and the process exits
non-zero — nothing is swallowed. Receipts have **no identity field**: every run
is a distinct fact and must never resolve onto a previous run.

`summary` is composed by us from counts and exception *class* names — never an
exception message, never feed text. Same finding as ADR 012: an entity outlives
the data it quotes, `entity.search` is a generated tsvector over
`attributes::text`, and `forget()` is per-entity, so third-party text copied
into a receipt would survive erasure of its source. Full error text goes to
stderr and the scheduler log, which is not a queryable store.

**The briefing is assembled, not generated.** `domains.ops.briefing` is
deterministic and zero-LLM (the roadmap's standing proactivity ceiling —
watch / summarize / remind / draft only): today's appointments in chronological
order, every open `link_review` item, and the most recent `daily_checkin` if one
exists. It is display-only — no notification, no email, no outbound request, and
it writes nothing to anything it read.

**It cites IDs; it does not copy text.** The briefing stores
`appointment_ids` (chronological), `open_review_ids`, `latest_checkin_id`, and
the ADR 010 envelope `{source_entity_ids, source_event_ids, method,
confidence: 1.0}` — and no titles, no locations, no attendee emails, no note
text. So it carries no `x-pii` field and needs no erasure path of its own: the
cited entities remain the single place person-identifying text lives and the
single place `forget()` has to reach, and a briefing that outlives an erasure
still resolves to correctly redacted entities. `source_event_ids` are the
latest event id of each cited entity, so the exact state the briefing saw is
replayable (invariants 2/3).

"Open" `link_review` means *every* `link_review` entity: ADR 013 shipped the
queue without a resolution mechanism, so nothing is closed yet. When a resolve
path lands, the filter lands with it.

**Idempotency.** The briefing is identified by `briefing_key` (the local date).
A re-run assembles the same attributes and compares them against the stored
briefing; identical means capture is skipped entirely, so a re-run emits zero
new events beyond its own receipt. The identity field is deliberately *not*
named `date`: `ExactIdentityResolver` matches on identity **field name** across
types, and `daily_checkin` already claims `date` — a briefing keyed on `date`
would resolve onto that day's check-in and merge into it.

**"Today" is a local date.** Appointment `starts_at` is stored in UTC (ADR 012);
the briefing converts to `LIFEOS_BRIEFING_TZ` (IANA name, default UTC) before
taking the date, so an evening appointment does not land in tomorrow's briefing.

**trigger_feedback is written by a human, never by a job.** `record_feedback`
stores `{subject_id, verdict, note?, recorded_at}` where verdict is exactly
`useful | noise | wrong`. It is keyed on `subject_id`, so re-judging supersedes
via `entity.updated` and the earlier verdict stays in history (invariant 3).
`note` is free text the owner writes and may name a person, so it **is** flagged
`x-pii` and has a regression test proving `forget()` removes it from live state
and from `find(ctx, text=...)`. Nothing emits feedback automatically; it exists
so "this briefing was noise" becomes a recorded signal for the prospective-
copilot milestone rather than a lost opinion.

**Contexts stay code-built and narrow** (the ADR 012/013 operator-script
pattern; agent tokens stay read-only per ADR 010 and never widen). Exactly:

| entry point | scopes |
|---|---|
| `domains.calendar.ingest` | `calendar:read`, `calendar:write`, `ops:read`, `ops:write` |
| `domains.calendar.autolink` | `calendar:read`, `calendar:write`, `relationships:read`, `relationships:write`, `ops:read`, `ops:write` |
| `domains.ops.briefing` | `calendar:read`, `wellbeing:read`, `ops:read`, `ops:write` |
| `ops.feedback` (human tool) | `ops:read`, `ops:write` |

`ops:write` is what lets a job emit its receipt; `ops:read` is required because
`list_types` filters by read scope, so a job that cannot read the `ops` domain
cannot tell whether its own types already exist. The briefing holds **no write
scope on anything it reads** — it cannot modify calendar or wellbeing data by
construction. `AccessContext.all()` appears nowhere outside operator scripts.

**Scheduling stays operator authority.** This slice ships the CLI entry points
and a runbox script (`install-lifeos-cron.ps1`) that installs a systemd timer on
the deploy box running ingest → autolink → briefing in order, each under its own
receipt, sequenced so one failing job never stops the next. The repository's
deploy workflow is untouched: merging this PR schedules nothing.

Lethal-trifecta check (invariant 8): the briefing job has broad read access and
lacks the other two legs — no external communication (no outbound request at
all) and no high-consequence write (one `ops` entity, display-only).

## Consequences

- The `ops` cell (`.agents/domains/ops/`) exists per invariant 10, and the
  guards cell map needs an `ops` entry for `src/domains/ops/**` +
  `tests/ops/**`.
- Agent tokens carry no `ops:read` until the operator re-mints, so receipts,
  briefings and feedback stay dark to MCP/chat by default (ADR 010 fail-closed).
- Every scheduled run is queryable: `find(ctx, type_name="execution_receipt")`
  answers "did the cron run, and what did it do" without shell access to the box.
- The briefing is only as readable as the entities it cites; a UI (B4) resolves
  IDs to text. That is the price of not duplicating erasable PII, and it is the
  right price.
- A briefing older than its cited entities is not a stale copy — it is a
  pointer, so it degrades to "these ids no longer exist" rather than to a lie.

## Revisit when

`link_review` gains a resolve path (the "open" filter lands with it), a second
consumer needs receipts as a metric series rather than entities, a scheduled job
needs to write outside its own domain, or feedback volume justifies a UI
(currently service + tests only, deliberately).

## Amended 2026-07-29 (roadmap §INT1, ADR 019)

The briefing was recomposed into the one morning digest of ADR 019 rule 1:
`focus_intention_ids` leads (the at-most-three focus intentions, whose entities
carry the floors and next physical actions), `appointment_ids` follows, and
nothing else until later slices' data exists — the `open_review_ids` and
`latest_checkin_id` pointers left the digest (feelings are pull-only; no
overdue or backlog counts, rule 2). The Monday edition adds `gate`: utility-
gate status per rule 9, days-with-a-check-in per week over the four complete
Mon–Sun weeks behind it, counts and a met boolean only. `domains.ops.briefing`
now also holds `intentions:read` (still no write scope on anything it reads).
An existing database runs `scripts/migrate_briefing_composition.py` once.
