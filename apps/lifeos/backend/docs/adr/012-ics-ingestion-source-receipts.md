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

**No auto-link.** The attendee identity field is deliberately attendee-private
(`email_hash`, see "Durable erasure"), never the person spine's `emails`, so
exact-identity resolution never merges feed attendees onto the spine. Linking
attendees to people is B2's explicit auto-link pass, on purpose.

**Durable erasure (slice 7).** The original design made `email` both the
attendee's `x-identity` field and an `x-pii` field. `forget()` strips x-pii,
so an erased attendee stopped being findable — and because the ICS feed is
unchanged by erasure, the next feed edit re-captured the same address as a
**brand-new attendee entity**. The same shape hit appointments: `forget()`
strips `title`/`location`, and any later VEVENT edit re-materialized them onto
the same entity through capture's merge. Erasure silently undid itself, which
is precisely what invariant 9 ("a working deletion path") exists to prevent.
The double-run idempotency test passed throughout, because it never erased,
and the erasure test passed, because it never re-ingested. Three decisions:

- *Identity must be non-PII.* `attendee`'s `x-identity` becomes `email_hash`
  (sha256 of the lowercased, stripped address, hex); `email` stays an
  attribute and stays `x-pii`. `email_hash` is derived from PII but is **not**
  erasable by `forget()` — that is the point: it is the key that survives.
  Stated plainly: hashing an email is **not anonymization**. An address is a
  known, small, guessable domain, so anyone holding a candidate address can
  confirm a match by hashing it. `email_hash` is a *stable join key*, and it
  is acceptable here only because it never leaves the system (no API, MCP or
  UI surface renders it) and the app cannot turn it back into an address. It
  is also why nothing else may key on it as if it were anonymous.
- *Never write back a redacted field.* Before capturing over an existing
  appointment or attendee, ingestion reads that entity's `pii.redacted` events
  and strips every field they name from the attributes it is about to write
  (`_redacted_fields` in `ingest.py`). Non-PII fields keep updating normally —
  an erased appointment still tracks its `starts_at` — so the fix does not
  freeze ordinary updates. `title` is therefore no longer `required` on
  `appointment`, and `email` no longer `required` on `attendee`: an erased
  entity must still be capturable.
- *Migration, without kernel DDL.* `type_definition.name` is unique and
  `define_type` refuses a duplicate, so there is no "supersede with a second
  row" path and `define_missing` never touches an existing type — a database
  that already ran ingestion would keep the old schemas forever. Adding a
  redefinition service is a kernel change and out of scope. The path is
  therefore the operator-script pattern:
  `scripts/migrate_calendar_durable_erasure.py` rewrites the `attendee` and
  `appointment` schemas in place (with a `type.redefined` audit event) and
  backfills `email_hash` onto existing attendees as real `entity.updated`
  events plus projections, so a rebuild reproduces them. It is idempotent and
  runs once per environment before the new ingestion code. Existing attendees
  that still hold an `email` keep their id, edges and history and simply gain
  the key. Attendees erased *before* the migration cannot be re-keyed — the
  address is gone by design and no hash can be derived from nothing — so they
  keep their id, edges and history but will never match a feed again, and one
  further feed edit will mint a fresh attendee for that address; the script
  counts and warns about exactly those rows.

**Config.** Feed URLs come from `LIFEOS_ICS_URLS` (comma-separated) via
`kernel.env.read_env`; nothing is hardcoded and no real URL or feed content
enters the repo — test fixtures are synthetic.

## Consequences

- The calendar cell (`.agents/domains/calendar/`) exists per invariant 10.
- Double-run idempotency is a standing test
  (`tests/calendar/test_ingest.py::test_double_run_emits_nothing_new`), and so
  is durable erasure: erase, then re-ingest a *changed* feed that still names
  the subject
  (`::test_erased_attendee_is_not_recreated_by_a_changed_feed` and
  `::test_erased_appointment_fields_stay_erased_across_a_changed_feed`),
  alongside the proof that ordinary entities still update
  (`::test_changed_feed_updates_ordinary_appointments_and_attendees`).
- Re-keying costs one `history()` read per existing entity a changed VEVENT
  touches. Cheap at feed scale; it joins the "per-event `find` round-trips"
  revisit trigger below if attendee volume ever makes it measurable.
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
