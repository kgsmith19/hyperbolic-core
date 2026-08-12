Title: FEAT(db): re-pin all platform RLS policies to the owner UUID
Type: FEAT
Component: Toolbelt
Milestone: M1 Platform foundations
Depends on: m1-07-chore-platform-idp-owner-setup.md
Blocks: m1-09-feat-db-indexes-retention.md, m3-02-feat-toolbelt-registry-extension.md, m3-05-feat-intake-schema.md, m4-03-feat-po-injection-rpc.md, m5-01-feat-po-shell-contract.md

## Problem
Every core/idea policy is authenticated_all and prompt policies are generic auth.uid(), so fixture users can write live production schemas (SEC-03). 06-supabase-schema.md section 5.5 enumerates the replacement owner-pinned policies (patterns A, B, C) and the security definer gates on core.log_run and core.purge_old_events; sequence steps S4 and S5.

## Scope
In scope:
- Migration pair for core/idea re-pin including both security definer gates, per 06 section 5.5
- Migration pair for prompt re-pin (5 tables), per 06 section 5.5 and 05-d section 2
- InitPlan wrapping of every owner() and auth.uid() reference per 06 section 5.6
Out of scope:
- New tables or indexes (m1-09, m3-02, m3-05)
- CI credential mechanics (done in m1-07)

## Acceptance criteria
If a request presents a fixture-user token, then every select on core, idea, and prompt tables shall return zero rows and every write shall fail with a 4xx status.
When the owner token issues the same requests, all existing suites shall pass unchanged.
When core.log_run is called with a non-owner subject, it shall raise with errcode 42501.
API roles shall lack EXECUTE on core.purge_old_events after the migration.
An EXPLAIN of a policied prompt.prompt select shall show the owner lookup as an InitPlan, not a per-row SubPlan.

## Verification
node --test apps/toolbelt/tests/ (negative-path fixture cases assert zero rows and 4xx; positive owner cases green)
psql with a fixture JWT context: select core.log_run(...); fails with 42501
psql: select has_function_privilege('authenticated','core.purge_old_events()','execute'); returns f
psql: explain (format json) select * from prompt.prompt; output contains "InitPlan"

## Estimated LOC delta
Added: 220  Deleted: 60  Net: +160

## Risk
Medium; the single riskiest data-layer change in V1, mitigated by the never-breaks-CI sequence and paired down migrations.
