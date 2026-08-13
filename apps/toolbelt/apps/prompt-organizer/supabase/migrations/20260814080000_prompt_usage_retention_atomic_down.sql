-- Reverts 20260814080000_prompt_usage_retention_atomic.sql: restores
-- prompt.purge_old_usage() to its pre-fix, two-statement body verbatim
-- (20260812210000_prompt_usage_retention.sql's original text). Deliberately
-- re-introduces the race this migration exists to fix.
create or replace function prompt.purge_old_usage() returns bigint
language plpgsql
security definer
set search_path = prompt, pg_temp
as $$
declare
  v_purged bigint;
begin
  insert into prompt.usage_monthly_agg (prompt_id, month, copy_count)
  select prompt_id, date_trunc('month', created_at)::date, count(*)
  from prompt.usage
  where created_at < now() - interval '365 days'
  group by 1, 2
  on conflict (prompt_id, month) do update
    set copy_count = prompt.usage_monthly_agg.copy_count + excluded.copy_count;

  with deleted as (
    delete from prompt.usage
    where created_at < now() - interval '365 days'
    returning 1
  )
  select count(*) into v_purged from deleted;
  return v_purged;
end;
$$;
