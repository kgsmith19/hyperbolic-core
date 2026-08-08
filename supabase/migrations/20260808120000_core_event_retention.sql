-- FR-008: core.event is deleted after 90 days, but never silently -- every
-- deleted row's month gains 1 in a permanent total first. Realizes DR-003 /
-- Q-002 ("90 days hot, then a monthly aggregate kept forever"), tracked as
-- an accepted risk in SPEC-0000 RISK-001 until this slice.
--
-- security definer, search_path pinned, same reasoning and precedent as
-- core.log_run (SPEC-0003): not required today (core.event's existing
-- blanket authenticated grant already permits a direct delete), but keeps
-- this function working unchanged if that grant is ever tightened later.
--
-- The self-referential core.event.parent_id FK has no "on delete" action,
-- so a to-be-purged child whose parent is not yet 90 days old would fail
-- this call atomically -- named as RISK-010 in SPEC-0004, not solved here,
-- since no row has ever used parent_id (nothing writes step-level events
-- yet).
create table core.event_monthly_agg (
  month        date not null primary key,
  event_count  bigint not null default 0
);

alter table core.event_monthly_agg enable row level security;
alter table core.event_monthly_agg force row level security;
create policy authenticated_all on core.event_monthly_agg for all to authenticated using (true) with check (true);

create function core.purge_old_events() returns bigint
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

grant execute on function core.purge_old_events() to authenticated;

create extension pg_cron;

select cron.schedule(
  'core-purge-old-events',
  '0 3 * * *',
  $$select core.purge_old_events();$$
);
