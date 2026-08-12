Title: FEAT(shell): platform cost dashboard
Type: FEAT
Component: Shell
Milestone: M6 Hardening
Depends on: m4-17-feat-brain-observability-cost.md, m4-05-feat-llm-handler-service.md
Blocks: none

## Problem
Cost data lands in the Brain cost table, the core mirror, and core.llm_call, but no surface answers per-run, per-caller, or per-day spend questions (07-brain-architecture.md section 7.9; 08-llm-handlers.md section 6 attribution model).

## Scope
In scope:
- Shell dashboard panel: Brain cost per run, per task, per harness, per day; core.llm_call group-bys per caller_app and purpose
- Read-only queries through the platform session; no new tables
Out of scope:
- Billing-API integration (08 gate question 2 default: manual rates table); alert thresholds

## Acceptance criteria
When fixture runs and llm calls exist, the dashboard shall render non-null totals matching direct SQL group-bys.
Attribution shall resolve per caller_app and per run_ref exactly as inserted.
The panel shall render within 500 ms p95 warm.

## Verification
Playwright dashboard spec comparing rendered totals against psql group-by output for seeded fixtures
Attribution case in the same spec
Perf trace assertion for the render budget

## Estimated LOC delta
Added: 300  Deleted: 0  Net: +300

## Risk
Low; group-by reads over existing telemetry.
