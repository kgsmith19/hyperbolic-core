-- Independent security review, Finding 33 (re-verified against current
-- HEAD): core.purge_old_events() aggregates and deletes in two separate
-- top-level statements inside one plpgsql function body --
--   1. `insert into core.event_monthly_agg ... select ... from core.event
--      where at < now() - interval '90 days' ... on conflict (month) do
--      update set event_count = event_count + excluded.event_count`
--   2. `with deleted as (delete from core.event where at < now() -
--      interval '90 days' returning 1) select count(*) into v_purged`
--
-- Under READ COMMITTED (the default, and what pg_cron's scheduled call
-- runs under), each of those is its own statement with its own snapshot.
-- Two concurrent invocations of this function -- both possible in
-- principle (nothing prevents pg_cron from overlapping a slow run with the
-- next day's schedule, or an operator invoking it by hand while the cron
-- job is mid-run) -- can each execute statement 1 against the SAME
-- still-live rows before either reaches statement 2: both computations see
-- the identical un-deleted event rows, so both add the identical count to
-- core.event_monthly_agg via the ON CONFLICT DO UPDATE arithmetic
-- (`event_count = event_count + excluded.event_count`), permanently
-- double-counting that month's total. The subsequent DELETE step is safe
-- either way (Postgres row-level locking means the same row can only
-- actually be deleted once -- whichever transaction's DELETE commits first
-- removes it, and the second transaction's DELETE, on re-evaluating its
-- WHERE clause against the now-vanished row per the standard READ
-- COMMITTED EvalPlanQual recheck, simply finds nothing left to delete), so
-- this is a pure aggregate-inflation bug, not a double-delete or a crash --
-- which is exactly what makes it dangerous: nothing errors, nothing looks
-- wrong operationally, and core.event_monthly_agg.event_count silently
-- drifts upward of the true historical total with no way to recover the
-- correct figure afterward (the source rows are already gone).
--
-- Fix: replace the two independent statements with ONE statement --
-- `with deleted as (delete ... returning at), aggregated as (insert ...
-- select ... from deleted ... on conflict do update ...) select count(*)
-- into v_purged from deleted`. The `aggregated` CTE's own SELECT reads
-- exclusively from `deleted`'s RETURNING output (never re-queries
-- core.event directly), so aggregation is now a value computed FROM the
-- exact rowset this statement itself claimed and removed, not a fresh scan
-- of the table -- something a second, concurrently-running invocation
-- cannot cause to double-count, because there is no longer a window where
-- one invocation's aggregate step can observe rows another invocation's
-- delete step has not yet claimed. Postgres's row-level locking on the
-- `deleted` CTE's own DELETE (unavoidable: it is a real DELETE against
-- core.event) is what makes this safe under real concurrency: a second
-- concurrent call attempting the same DELETE blocks on the row locks the
-- first call's DELETE holds, and once the first call commits, the second
-- call's own DELETE re-evaluates its WHERE clause against those specific
-- rows and finds them already gone -- so its own `deleted` CTE returns
-- zero rows, and therefore its `aggregated` CTE (which selects only from
-- `deleted`, `group by` on an empty input) contributes nothing. Confirmed
-- empirically in this session's own sandbox, both structurally (verified
-- that an unreferenced data-modifying CTE inside a WITH clause still
-- executes -- PostgreSQL does not skip a CTE's side effects just because
-- the primary query does not select from it, confirmed against a real
-- local engine before relying on that behavior here) and by direct
-- concurrency reproduction (two real, genuinely-blocked concurrent
-- sessions forced to contend for the same rows via a third session's held
-- `FOR UPDATE` lock, released only once both are confirmed blocked in
-- pg_stat_activity -- see
-- apps/toolbelt/tests/core-event-retention-atomic.test.mjs, which also
-- reproduces the OLD two-statement shape's double-count deterministically
-- via explicit statement interleaving, the same worst-case ordering real
-- concurrent transactions can produce under READ COMMITTED).
--
-- No grant/RLS/schema change: this migration only replaces the function
-- body (CREATE OR REPLACE FUNCTION preserves the existing ACL, matching
-- this repo's own established pattern, e.g.
-- 20260814010000_core_log_run_owner_null_guard.sql's identical posture).
-- core.purge_old_events() remains cron-only (EXECUTE already revoked from
-- public/anon/authenticated by 20260814020000_core_purge_old_events_revoke_public.sql).
create or replace function core.purge_old_events() returns bigint
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_purged bigint;
begin
  with deleted as (
    delete from core.event
    where at < now() - interval '90 days'
    returning at
  ),
  aggregated as (
    insert into core.event_monthly_agg (month, event_count)
    select date_trunc('month', at)::date, count(*)
    from deleted
    group by 1
    on conflict (month) do update
      set event_count = core.event_monthly_agg.event_count + excluded.event_count
  )
  select count(*) into v_purged from deleted;

  return v_purged;
end;
$$;
