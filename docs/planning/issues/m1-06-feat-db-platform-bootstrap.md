Title: FEAT(db): platform schema, owner() helper, and test fence
Type: FEAT
Component: Toolbelt
Milestone: M1 Platform foundations
Depends on: m1-05-chore-ci-platform-migrations-workflow.md
Blocks: m1-07-chore-platform-idp-owner-setup.md

## Problem
RLS policies today allow any authenticated fixture user to write live core/idea/prompt rows (SEC-03, 02-health-audit.md). The re-pin needs the platform.owner() helper and the test schema fence first; normative DDL is 06-supabase-schema.md sections 5.2 and 5.3 (migration sequence step S1).

## Scope
In scope:
- Migration pair for the platform schema, platform.config, and platform.owner() per 06 section 5.2
- Migration pair for the test schema and test.scratch fence per 06 section 5.3, including the pgrst.db_schemas update
Out of scope:
- The owner UUID insert (operator step, m1-07)
- Policy re-pins (m1-08)

## Acceptance criteria
When the migrations apply, platform.owner() shall exist and shall return null before any config row is inserted, so every owner-pinned comparison evaluates false (fail closed).
PostgREST shall not expose the platform schema.
When an authenticated fixture token inserts into test.scratch, the insert shall succeed.
CI shall remain green with no policy changed (sequence S1 property).

## Verification
psql "$SUPABASE_DB_URL" -c "select platform.owner() is null" returns t (pre-insert)
curl -s "$SUPABASE_URL/rest/v1/config" -H "Accept-Profile: platform" -H "apikey: $ANON" returns an error, never rows
node --test apps/toolbelt/tests/ (fixture liveness case writes test.scratch)
Toolbelt PR Gate green on the PR

## Estimated LOC delta
Added: 90  Deleted: 0  Net: +90

## Risk
Low; pure additions, no existing policy or table touched.
