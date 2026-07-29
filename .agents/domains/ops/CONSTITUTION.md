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
- Behavior changes land with tests in `tests/ops/` (integration against the
  kernel, unit for pure assembly logic).
