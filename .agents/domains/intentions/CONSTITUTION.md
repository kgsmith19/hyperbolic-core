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
