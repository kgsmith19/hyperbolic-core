-- Restores the preceding atomic function body without reopening the API
-- execution path closed by 20260814030000.
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

revoke execute on function prompt.purge_old_usage()
  from public, anon, authenticated, service_role;
