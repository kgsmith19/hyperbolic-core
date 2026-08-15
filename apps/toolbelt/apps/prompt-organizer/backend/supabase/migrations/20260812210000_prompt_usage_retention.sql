-- prompt.usage retention (365 days hot, monthly aggregate forever) and the
-- test.scratch 7-day purge. Source: docs/planning/06-supabase-schema.md
-- section 8, applied verbatim. The test.scratch cron job lives here rather
-- than split into its own toolbelt-root migration: unlike the indexes
-- migrations, cron.schedule() registers a job body, not schema DDL, so it
-- carries none of the "one DDL writer per schema" ownership concern, and
-- 06's own filename for this migration (prompt_usage_retention) already
-- groups it with the prompt retention work it was authored alongside.
-- pg_cron is already installed (20260808120000_core_event_retention.sql), so
-- this adds no new extension.
create table prompt.usage_monthly_agg (
  prompt_id   uuid not null,
  month       date not null,
  copy_count  bigint not null default 0,
  primary key (prompt_id, month)
);
-- No FK to prompt.prompt: the aggregate must survive a prompt row's deletion,
-- same reasoning as core.event_monthly_agg's standalone shape.
alter table prompt.usage_monthly_agg enable row level security;
alter table prompt.usage_monthly_agg force row level security;
create policy owner_rw on prompt.usage_monthly_agg
  for all to authenticated
  using ((select auth.uid()) = (select platform.owner()))
  with check ((select auth.uid()) = (select platform.owner()));

create function prompt.purge_old_usage() returns bigint
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
-- cron-only, like core.purge_old_events post-re-pin: no EXECUTE grant to API roles.

select cron.schedule('prompt-purge-old-usage', '10 3 * * *',
  $$select prompt.purge_old_usage();$$);

select cron.schedule('test-purge-scratch', '20 3 * * *',
  $$delete from test.scratch where created_at < now() - interval '7 days';$$);
