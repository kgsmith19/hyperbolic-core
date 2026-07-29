# Calendar cell

Owns: `src/domains/calendar/**`, `tests/calendar/**`.

- A life domain, not kernel: types are registry data (invariant 1), state
  changes go through kernel application services only — capture/relate/find,
  never raw tables or SQL (invariant 7).
- Feed content is untrusted input: bound sizes, skip malformed components
  with a count, never crash the run on bad data. Fetches are http(s)-only
  and follow redirects only within the configured feed host (SSRF guard).
- Ingestion is idempotent: re-running against unchanged sources emits zero
  new events (receipt sha short-circuit + per-VEVENT hash).
- Receipts are hash-plus-metadata only: never store verbatim feed payloads
  or any third-party text that cannot be erased per-subject via forget()
  (invariant 9, ADR 012).
- An identity field is never a PII field. `forget()` strips x-pii, so keying
  on PII makes an erased entity unfindable and the next feed change resurrects
  it as a new entity; ingestion also never writes back a field the entity's
  `pii.redacted` history names (invariant 9, ADR 012 "Durable erasure").
- Every derived entity links to its source receipt via a `derived_from` edge
  carrying `{method, confidence}` (ADR 010 provenance convention, ADR 012).
- Runs under a narrow code-built AccessContext, never `AccessContext.all()`:
  `calendar:read`/`write` for ingestion (ADR 012), plus
  `relationships:read`/`write` for the auto-link pass, whose edges span both
  domains (ADR 013), plus `ops:read`/`write` for the run's own execution
  receipt and nothing else (ADR 014).
- Both CLIs are scheduled entry points: they run inside `ops.receipts.run_job`,
  so every run leaves a receipt (ok/failed/skipped) and only `ok` exits 0.
  Receipts carry counts and exception class names — never feed text, never an
  exception message (ADR 012/014).
- Auto-link is deterministic and exact — no LLM, no fuzzy matching, no name
  matching; it emits edges and review items only, never merges or rewrites the
  person spine (invariant 4, ADR 013). Ambiguity goes to `link_review`, which
  stores entity IDs and a reason code and never third-party PII.
- Secrets stay out: never log or store a feed URL (it may embed a token) —
  redacted host + hashes only.
- Behavior changes land with tests in `tests/calendar/` (unit for parsing,
  integration for ingestion).
