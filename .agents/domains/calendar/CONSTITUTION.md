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
- Every derived entity links to its source receipt via a `derived_from` edge
  carrying `{method, confidence}` (ADR 010 provenance convention, ADR 012).
- Runs under a narrow code-built AccessContext (`calendar:read` +
  `calendar:write`), never `AccessContext.all()` (ADR 012).
- Secrets stay out: never log or store a feed URL (it may embed a token) —
  redacted host + hashes only.
- Behavior changes land with tests in `tests/calendar/` (unit for parsing,
  integration for ingestion).
