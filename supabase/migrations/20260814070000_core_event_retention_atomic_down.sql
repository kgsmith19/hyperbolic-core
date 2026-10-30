-- Reverts 20260814070000_core_event_retention_atomic.sql: restores
-- core.purge_old_events() to its pre-fix, two-statement body verbatim
-- (20260808120000_core_event_retention.sql's original text). Deliberately
-- re-introduces the race this migration exists to fix -- a down migration's
-- job is symmetry with the up migration, not safety; reverting past this
-- point means knowingly reverting to the racy behavior.
create or replace function core.purge_old_events() returns bigint
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_purged bigint;
begin
  insert into core.event_monthly_agg (month, event_count)
  select date_trunc('month', at)::date, count(*)
  from core.event
  where at < now() - interval '90 days'
  group by 1
  on conflict (month) do update
    set event_count = core.event_monthly_agg.event_count + excluded.event_count;

  with deleted as (
    delete from core.event
    where at < now() - interval '90 days'
    returning 1
  )
  select count(*) into v_purged from deleted;

  return v_purged;
end;
$$;
