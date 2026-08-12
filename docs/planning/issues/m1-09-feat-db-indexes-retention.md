Title: FEAT(db): observed-query indexes and usage retention
Type: FEAT
Component: Toolbelt
Milestone: M1 Platform foundations
Depends on: m1-08-feat-db-rls-owner-repin.md
Blocks: none

## Problem
Four observed query patterns have no covering index (06-supabase-schema.md section 6, Q1/Q3/Q4/Q9) and prompt.usage grows unboundedly with every copy and injection (06 section 8).

## Scope
In scope:
- Index migration pair per 06 section 6 (prompt_created_at, usage_prompt, score_idea, event_at)
- Retention migration pair per 06 section 8: prompt.usage_monthly_agg, prompt.purge_old_usage, pg_cron entries at 03:10 and the test.scratch purge at 03:20
Out of scope:
- Any further index (06 lists the deliberate non-indexes with reasons)

## Acceptance criteria
When the migrations apply, the four indexes named in 06 section 6 shall exist.
When prompt.purge_old_usage runs against fixture rows older than 365 days, the rows shall be aggregated into usage_monthly_agg and deleted, and the function shall return the purged count.
API roles shall lack EXECUTE on prompt.purge_old_usage.
Both cron jobs shall be scheduled.

## Verification
psql: select indexname from pg_indexes where indexname in ('prompt_created_at','usage_prompt','score_idea','event_at'); returns 4 rows
node --test apps/toolbelt/apps/prompt-organizer/tests/retention.test.mjs (seeded purge case)
psql: select has_function_privilege('authenticated','prompt.purge_old_usage()','execute'); returns f
psql: select jobname from cron.job where jobname in ('prompt-purge-old-usage','test-purge-scratch'); returns 2 rows

## Estimated LOC delta
Added: 100  Deleted: 0  Net: +100

## Risk
Low; additive indexes and a purge pattern already proven on core.event.
