Title: DOCS(planning): freeze docs/planning and record risk sign-offs
Type: DOCS
Component: hyperbolic-core
Milestone: M6 Hardening
Depends on: m6-01-feat-brain-eval-seed-corpus.md, m6-02-feat-shell-cost-dashboard.md, m6-03-chore-ci-platform-backup.md
Blocks: none

## Problem
The committed planning set risks becoming a parallel source of truth against the operator's own forbidden-artifacts standard; 13-dissent.md C1 prescribes the freeze rule (docs/planning becomes read-only provenance once implementation starts, edits only via a superseding Issue). The Brain harness-economics question (13 C5, 07 gate question 1) needs a recorded decision and kill criterion before V1 closes.

## Scope
In scope:
- Freeze notice in docs/planning/README.md declaring the set point-in-time provenance, with the superseding-Issue edit rule
- Recorded dispositions for every batched gate question across artifacts 00 through 13, including the harness-economics decision (VPS metered dispatch vs operator-machine workers) with its kill criterion
- Risk sign-off table: each accepted risk named with its owner and reversal trigger
Out of scope:
- Any change to planning content itself (the freeze forbids it); implementation of any reversed decision (new Issues)

## Acceptance criteria
The freeze notice shall exist in docs/planning/README.md and name the superseding-Issue rule.
Every gate question across the planning artifacts shall have a recorded disposition (answered, accepted-default, or reversed-with-issue-link).
The harness-economics decision shall be recorded with an explicit kill criterion.
The whole planning set shall contain zero em dashes after edits.

## Verification
grep -n "freeze" docs/planning/README.md shows the notice
Script cross-checking every "Gate questions" section against the disposition table reports zero unanswered
Economics decision row present with a kill criterion sentence
EMDASH=$(printf '\342\200\224'); grep -rc "$EMDASH" docs/planning/ | awk -F: '$2!=0' returns empty

## Estimated LOC delta
Added: 80  Deleted: 0  Net: +80

## Risk
Low; documentation closure that prevents a parallel source of truth.
