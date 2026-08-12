# Episodes cell

Owns: `src/domains/episodes/**`, `tests/episodes/**`.

- A life domain, not kernel: types are registry data (invariant 1), state
  changes go through kernel application services only — capture/find, never
  raw tables or SQL (invariant 7).
- **x-sensitive from the first definition** (roadmap §EP1, ADR 016): `episode`
  and `playbook` both carry `x-sensitive: true` in the schema that first
  defines them — the flag is never added by a later migration, so no window
  exists in which this domain is readable through the shared agent-tool
  surface. Any future type in this domain carries the flag in its first
  definition too.
- Pre-made decisions, verbatim from roadmap §EP1 (the contract): "no
  prediction, no risk scores, no physiology dashboards, no push prompts, no
  exposure coaching, no clinical advice; playbook and episodes are
  operator-authored via capture, never generated."
- Pull-only, verbatim from the roadmap queue entry: "no notification path may
  exist in code." Nothing in this cell — and nothing consuming it — may
  schedule, push, prompt, remind, or notify; the operator asks, the system
  answers.
- Capture-door rules, service-enforced in `capture.guard_capture` (the
  bills/documents/intentions dispatch precedent): intensity within 0-10;
  `end_date` never before `onset_date`; `feared_duration_days` positive;
  playbook versions are append-only — a new version never edits a prior one.
  `onset_date` is the episode identity key and is embargoed door-wide (no
  other type may carry it — the PR #49 guard-the-record precedent);
  `playbook` declares no identity fields, so nothing can merge into a
  recorded version (the authority_receipt precedent, ADR 014/018).
- Daily in-episode intensity is a plain entity update through existing
  capture: the append-only history IS the time series. No episode-specific
  capture UI or ingestion code may exist for it.
- `onset_date` is identity and therefore never x-pii (the
  identity-is-never-PII rule, ADR 012); every other episode field and
  playbook `steps` are x-pii and erasable via forget().
- Synthetic fixtures only: no operator personal content in code, tests,
  commit messages, or PR text (x-sensitive handling rule).
- Behavior changes land with tests in `tests/episodes/`.
