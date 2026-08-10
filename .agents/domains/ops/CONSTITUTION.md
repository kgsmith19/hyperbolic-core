# Ops cell

Owns: `src/domains/ops/**`, `tests/ops/**`.

- A life-adjacent domain, not kernel: `execution_receipt`, `briefing` and
  `trigger_feedback` are registry data (invariant 1) and every state change
  goes through kernel application services — capture/find/get_entity, never
  raw tables or SQL (invariant 7).
- Every scheduled entry point runs inside `run_job`: a receipt is emitted on
  success, failure and skip alike, and only `ok` exits 0. A misconfigured or
  crashed job must never look like "nothing to do" (ADR 014).
- Receipts and briefings are counts, statuses and entity IDs — never
  exception messages, never feed text, never appointment titles or attendee
  emails. An entity outlives what it quotes and `forget()` is per-entity
  (invariant 9, ADR 012/014); cite IDs instead.
- The briefing is assembled, never generated: zero LLM, deterministic,
  display-only. It reads without write scope on anything it reads, sends
  nothing, and makes no outbound request (invariant 8).
- Derived output carries the ADR 010 envelope `{source_entity_ids,
  source_event_ids, method, confidence}` citing what it was built from.
- Re-runs are idempotent: unchanged inputs emit zero new events beyond the
  run's own receipt.
- Runs under narrow code-built AccessContexts, never `AccessContext.all()` —
  the exact scope set per entry point is the table in ADR 014.
- `trigger_feedback` is written by a human only; no job may emit a verdict on
  its own output.
- The briefing's `cpap_compliance` key (roadmap H2) is computed by the cpap
  cell (`domains.cpap.compliance.compliance_for_briefing`) and only assembled
  here — the same optional-key seam `gate` and `episodes_line` already use.
  Absent entirely when that day's 30-night window has zero nights of session
  data; `ops` never fabricates a compliance result for a source that has
  reported nothing near this date.
- The source-freshness ledger (`domains.ops.freshness`, issue #90) is a pure
  query, not a persisted type: it derives `fresh | stale | unavailable |
  never_seen` per configured external source from existing
  `execution_receipt` / `source_receipt` / capture timestamps, writes
  nothing, and never fabricates a green state for a missing or failed
  source. No LLM is involved.
- Behavior changes land with tests in `tests/ops/` (integration against the
  kernel, unit for pure assembly logic).
