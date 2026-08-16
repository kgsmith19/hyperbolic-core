# ADR 019: Operator-fit rules for wellbeing-adjacent surfaces

## Status

Accepted, 2026-07-29.

## Context

The 2026-07-29 roadmap revision queues the first surfaces that touch health
adherence, episodes, and other wellbeing-adjacent data (INT1, H1/H2, EP1, D1).
The research behind that revision (`docs/archived/2026-07-29/lifeos-research-v3-synthesis.md`,
§2.3-2.7 and §2.10) is consistent and in places blunt: for these surfaces,
visibility of one's own record is the evidenced intervention; push prompts
about feelings measurably reduce adherence; streak mechanics drive abandonment;
prediction of mood or episodes is not viable at personal scale and a false
alarm is itself harmful; and modeling another person without consent is
rejected outright. These findings are design constraints, not preferences, and
they cut across many future slices. Scattering them into `.agents/invariants.md`
one edit at a time would bury them; they belong in one document that every
wellbeing-adjacent slice cites.

## Decision

1. Plans push, feelings pull: one daily digest max; no notification may
   reference mood, symptoms, or episodes.
2. Weekly quotas with freezes and repair windows; no daily hard-reset
   streaks, badges, or overdue counts; restart-neutral copy everywhere.
3. Max 3 focus intentions; the system offers rotation, never addition.
4. Code computes, model narrates: any number reaching a draft carries
   provenance; every health formula names its anchor; no prediction of
   mood, episodes, or relationships; co-occurrence language only.
5. Repeated same-day wellbeing queries return the playbook verbatim.
6. The model never authors journal, reflection, or intimate prose, and
   never concludes clinically: compile, cite, stop.
7. Family members are untyped name strings; the system models the
   operator's behavior only; no drafted messages to family.
8. Episode, faith, and therapy-adjacent types are x-sensitive from
   their first migration.
9. Utility gate: nothing beyond the committed queue (through D1) starts
   until check-in + briefing + weekly review show ≥5 days/wk use for 4
   consecutive weeks, computed from kernel data.

## Consequences

- Binding on every slice from INT1 onward; slice prompts inherit these rules
  without restating them, and a slice that needs an exception writes a new ADR
  rather than quietly deviating.
- Rule 1 constrains composition (what the briefing may contain), rule 2
  constrains copy and scoring (D1's quota service), rule 3 is service-enforced
  (INT1), rules 4-6 constrain chat and every rollup narration, rules 7-8 are
  schema-level (type definitions and `x-sensitive` flags), and rule 9 is
  computable from kernel data — the briefing can report gate status itself.
- The roadmap's "deliberately not doing" list is the applied form of these
  rules; candidates that violate one are rejected at proposal time, not in
  review.
- These rules supersede the alternative of adding piecemeal constraints to
  `.agents/invariants.md`; the invariants stay architectural, and operator-fit
  rules live here.

## Revisit when

A rule measurably fights real sustained use (the gate's own data is the
evidence), or a clinician-guided need contradicts one — then amend by ADR,
never by a quiet slice-level exception.
