-- Defense-in-depth follow-up to the atomic retention migration: preserve its
-- delete-as-row-claim algorithm while pinning an empty search_path and
-- reasserting the cron-only EXECUTE boundary.
create or replace function prompt.purge_old_usage() returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purged          bigint;
  v_aggregate_rows  bigint;
begin
  with deleted as (
    delete from prompt.usage
    where created_at < statement_timestamp() - interval '365 days'
    returning prompt_id, created_at
  ), upserted as (
    insert into prompt.usage_monthly_agg (prompt_id, month, copy_count)
    select prompt_id, date_trunc('month', created_at)::date, count(*)
    from deleted
    group by 1, 2
    on conflict (prompt_id, month) do update
      set copy_count = prompt.usage_monthly_agg.copy_count + excluded.copy_count
    returning 1
  )
  select
    (select count(*) from deleted),
    (select count(*) from upserted)
  into v_purged, v_aggregate_rows;

  return v_purged;
end;
$$;

revoke execute on function prompt.purge_old_usage()
  from public, anon, authenticated, service_role;
