-- Independent security review, Finding 33 (re-verified against current
-- HEAD), part B: prompt.purge_old_usage() has the identical two-statement
-- aggregate-then-delete shape as core.purge_old_events()
-- (apps/toolbelt/supabase/migrations/20260808120000_core_event_retention.sql),
-- and the identical bug -- two concurrent invocations can both execute the
-- aggregate INSERT...SELECT against the same still-live prompt.usage rows
-- before either reaches its DELETE, permanently double-counting
-- prompt.usage_monthly_agg.copy_count for that (prompt_id, month). See
-- apps/toolbelt/supabase/migrations/20260814070000_core_event_retention_atomic.sql's
-- header comment for the full mechanism (identical here, prompt.usage in
-- place of core.event) and for how this fix was verified (structural CTE
-- behavior confirmed against a real local engine, plus a genuine two-session
-- concurrency reproduction using a third session's held FOR UPDATE lock).
--
-- Same fix shape: fold the aggregate INSERT and the DELETE into one
-- statement, with the aggregate's SELECT reading only from the DELETE's own
-- RETURNING output (`deleted`), never re-scanning prompt.usage directly, so
-- a concurrent invocation can no longer observe rows this invocation has
-- not yet claimed.
--
-- No grant/RLS/schema change; CREATE OR REPLACE FUNCTION preserves the
-- existing ACL. prompt.purge_old_usage() remains cron-only (EXECUTE already
-- revoked from public/anon/authenticated by
-- 20260814030000_prompt_purge_old_usage_revoke_public.sql). The unrelated
-- test.scratch cron job this same original migration also schedules is
-- untouched -- it is a plain DELETE with no aggregate step, so it carries
-- none of this race.
create or replace function prompt.purge_old_usage() returns bigint
language plpgsql
security definer
set search_path = prompt, pg_temp
as $$
declare
  v_purged bigint;
begin
  with deleted as (
    delete from prompt.usage
    where created_at < now() - interval '365 days'
    returning prompt_id, created_at
  ),
  aggregated as (
    insert into prompt.usage_monthly_agg (prompt_id, month, copy_count)
    select prompt_id, date_trunc('month', created_at)::date, count(*)
    from deleted
    group by 1, 2
    on conflict (prompt_id, month) do update
      set copy_count = prompt.usage_monthly_agg.copy_count + excluded.copy_count
  )
  select count(*) into v_purged from deleted;

  return v_purged;
end;
$$;
