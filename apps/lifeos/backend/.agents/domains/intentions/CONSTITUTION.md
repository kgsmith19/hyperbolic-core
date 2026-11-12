# Intentions cell

Owns: `src/domains/intentions/**`, `tests/intentions/**`.

- A life domain, not kernel: types are registry data (invariant 1), state
  changes go through kernel application services only — capture/find, never
  raw tables or SQL (invariant 7).
- Display-only by decision (roadmap INT1): no triggers, no scheduler, no
  recurrence, no completion analytics — E1 owns all of those. Floors are
  plain strings, never structured.
- At most three intentions carry focus=true (ADR-019 rule 3: the system
  offers rotation, never addition). The rule is service-enforced
  (`focus.guard_capture`); the generic capture door dispatches to it and
  in-process writers capture through `capture_intention`, never a bare
  `services.capture` of an intention.
- `title` is the identity key and therefore never x-pii (the
  identity-is-never-PII rule, ADR 012); the operator's free-text fields
  (`floor`, `next_action`, `source`) are x-pii and erasable via forget().
- Behavior changes land with tests in `tests/intentions/`.

## Needs Me queue (#532, first slice)

`domains.intentions.needs_me` lists open intentions in order: soonest deadline first, then planner priority. Rules:

- Never invents content. An item with no `next_action` is listed and flagged `no_next_action`. A deadline with no `deadline_source` is flagged `deadline_unsourced`.
- Snoozed items (`snoozed_until`) are hidden until that date, then return.
- Candidates, anchors and DONE items are never listed.
- Completion requires `completion_evidence`: the operator's own confirmation or a named external source. A status change alone never completes an item.
- Every write re-captures the same intention through the identity-match merge (one `entity.updated` event). Repeating an action that changes nothing writes no event.

New optional fields on `intention`: `deadline`, `snoozed_until`, `deadline_source`, `starter`, `prerequisites`, `completion_evidence`. Existing databases need `python -m scripts.migrate_intention_needs_me` once. Routes: `GET /needs-me`, `POST /intentions/{id}/snooze|reschedule|complete`.
