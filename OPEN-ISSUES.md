# Open issues — lifeos

Standing ledger of things raised and not fixed. Entry format and the
resolution rule live in `C:\code\OPEN-ISSUES.md`. `/resolve-issues` works this
list to zero.

Not for this file: roadmap slices and event-triggered gates (they live in
`docs/roadmap.md` with explicit triggers), and ADR "revisit when" clauses.

---

## Open

## OI-001 Domain-scoped identity-field guards missing
- opened: 2026-07-30
- where: identity-field guards; `wellbeing`, `relationships`, `ops`, `calendar`
- what: guard coverage is per-cell, so those four domains' identity keys are
  unguarded against cross-domain writes
- why open: raised in the QE2-A security review and accepted as a legitimate
  feature gap rather than fixed; source `../SECREV-QE2-A.md:54-66`
- done when: a write to an identity field in each of the four domains from
  outside its owning cell is rejected, with a test per domain

## OI-002 `lines.py` (episodes) is 291 lines vs the ~150 guideline
- opened: 2026-07-30
- where: episodes `lines.py`
- what: file is roughly double the size guideline
- why open: adjudicated at EP1 as churn not worth a standalone split; fair game
  once a slice touches the file
- done when: the file is under the guideline with no behavior change and the
  episodes suite is green

## OI-003 Chat error frames leak raw exception text
- opened: 2026-07-30
- where: chat SSE error frames
- what: the raw exception string is passed through to the client
- why open: accepted while chat is single-owner; flagged to revisit if
  agent-scoped chat lands
- done when: error frames carry a safe message plus a correlation id, the
  detail stays server-side in logs, and a test asserts no exception text on the
  wire

## OI-004 Test-DB pool saturates under parallel agents
- opened: 2026-07-30
- where: test database pool / pytest-xdist config
- what: parallel agent runs exhaust the test-DB pool
- why open: noted as a watch item, never tuned
- done when: the suite runs green at the parallelism actually used, without
  pool-exhaustion errors

## Resolved

_(none yet)_
