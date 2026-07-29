# ADR 012: Read-only ICS ingestion with source receipts

## Decision

**Shape.** Calendar is a life domain, not kernel: three `type_definition`
rows (`appointment`, `attendee`, `source_receipt`, domain `calendar`) plus a
module `src/domains/calendar/` — zero kernel DDL (invariant 1, ADR 002) and
no new deployable (ADR 009). Every state change goes through kernel
application services (`capture`/`relate`/`find`/`get_entity`); the module
holds no SQL, so untrusted feed text only ever reaches the database
parameterized.

**Auth.** The roadmap said "runs under a schedule-scoped token"; that is
adjudicated away for now. Agent tokens are deliberately read-only — mint and
verify both refuse write scopes (ADR 010) — and weakening that for a cron
would be worse than not using tokens. Ingestion runs as
`python -m domains.calendar.ingest` (invoked by the deploy box's scheduler)
under a code-built AccessContext of exactly `calendar:read` +
`calendar:write` — narrow by construction, the operator-script pattern.
Token-based scheduling is revisited when the cron slice (B3) lands.

**Identity & idempotency.** One-off events key on their ICS `UID` (a
reschedule updates the same appointment); recurring series key on
`uid:original-slot` per expanded occurrence (the expander stamps every
occurrence with its RECURRENCE-ID slot, so a moved instance keeps its key).
Each occurrence carries `vevent_hash` — sha256 of its canonical
serialization. Re-runs emit nothing new twice over: identical feed bytes
short-circuit on the receipt's content hash before any parsing, and within a
changed feed only VEVENTs whose hash moved are re-captured. An update lands
as `entity.updated` via `capture`'s identity resolution — prior state stays
in the append-only history (invariants 2/3), which is the supersede chain.

**Receipts are hash-plus-metadata, never the payload.** Every fetch that
changes anything stores a `source_receipt` entity via the existing
capture/event mechanism: `sha256` + `fetched_at` + `size_bytes` +
occurrence/skipped counts, keyed by content-hash + URL-hash. The roadmap's
"raw source receipt stored" is adjudicated down to this on invariant-9
grounds: verbatim third-party feed text carries every attendee's email and
every title/location, `forget()` is strictly per-entity, and
`entity.search` is a generated tsvector over `attributes::text` — so a
stored payload would keep "erased" PII both retrievable and full-text
searchable (and reachable through chat, whose context reads every active
domain). Verbatim third-party payloads are therefore **not retained,
because they cannot be erased per-subject**; `sha256` remains the tamper
evidence (re-fetch the feed and compare). The feed URL itself is **never
stored or logged** — private ICS URLs embed capability tokens — only the
redacted host and a sha256 of the URL. Every derived appointment and
attendee links to its receipt with a `derived_from` edge carrying
`{method: "domains.calendar.ingest", confidence: 1.0, source_sha256}`
(the ADR 010 provenance convention); events are written with that method as
their actor.

**Untrusted input.** Feed content is hostile until proven otherwise:
512 KiB byte cap, http(s)-only sources, 30 s fetch timeout, redirects
followed only within the configured feed host and capped at 3 hops (the
first-hop scheme/host check alone would let a hostile 302 point the
scheduled fetch at internal addresses — SSRF), recurrence expansion
windowed (−30/+180 days by default) and capped at 1000
occurrences via a generator so a `FREQ=SECONDLY` bomb terminates, malformed
VEVENTs skipped with a count instead of crashing the run, text fields
truncated to schema bounds, and `additionalProperties: false` everywhere so
unvetted feed junk cannot land in attributes. Parsing uses the `icalendar` +
`recurring-ical-events` libraries (recurrence/timezone/EXDATE/override
handling is bought, not authored).

**No auto-link.** The attendee identity field is deliberately `email`
(singular), distinct from person's `emails`, so exact-identity resolution
never merges feed attendees onto the person spine. Linking attendees to
people is B2's explicit auto-link pass, on purpose.

**Config.** Feed URLs come from `LIFEOS_ICS_URLS` (comma-separated) via
`kernel.env.read_env`; nothing is hardcoded and no real URL or feed content
enters the repo — test fixtures are synthetic.

## Consequences

- The calendar cell (`.agents/domains/calendar/`) exists per invariant 10.
- Double-run idempotency is a standing test
  (`tests/calendar/test_ingest.py::test_double_run_emits_nothing_new`).
- Receipts make every calendar fact attributable to the exact fetch that
  produced it (content hash, source host, time); byte-level audit means
  re-fetching and comparing hashes, since payloads are not retained.
  Drop-and-rebuild still holds (projections replay from events).
- Feeds larger than 512 KiB fail the run loudly rather than ingest partially.

## Revisit when

B3 lands (scheduler + execution receipts may re-open token-scoped runs), a
real feed exceeds the size cap (raise it alongside a storage decision for
raw payloads), Google OAuth/webhook sync replaces polling, or attendee
volume makes per-event `find` round-trips a measured bottleneck.
