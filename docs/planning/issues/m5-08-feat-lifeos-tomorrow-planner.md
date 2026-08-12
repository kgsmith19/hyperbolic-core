Title: FEAT(lifeos): intentions daily planner on the Tomorrow page
Type: FEAT
Component: LifeOS
Milestone: M5 Component upgrades
Depends on: m2-08-feat-lifeos-shell-integration.md
Blocks: none

## Problem
Imported priorities never reach a plannable day view; the Tomorrow page and the intentions domain both exist but are unconnected (05-e-lifeos.md section 2 candidate g, selected).

## Scope
In scope:
- Intentions query into the Tomorrow page ordered by priority
- Done-state via the existing capture and event path (append-only)
- Done-state preservation across priority re-imports
Out of scope:
- New LLM calls on this path; any kernel change

## Acceptance criteria
The Tomorrow page shall list the day's intentions ordered by priority, and marking one done shall append an event, never mutate history (LO-3d).
When priorities are re-imported, existing done-states shall be preserved (LO-3e).
The planner query shall respond within 300 ms p95.

## Verification
vitest run Tomorrow (extended) and pytest tests/domains/intentions/test_planner.py (append-only assertion)
Re-import case in the same backend suite
Perf case (50-call p95)

## Estimated LOC delta
Added: 350  Deleted: 0  Net: +350

## Risk
Low; composes two existing mechanisms on the page the operator opens daily.
