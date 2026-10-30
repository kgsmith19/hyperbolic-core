-- Down migration for 20260812160000_core_idea_owner_pin.sql. Restores the
-- exact pre-re-pin policies and function bodies (20260806190200_rls_baseline.sql,
-- 20260807080000_core_log_run_rpc.sql, 20260808120000_core_event_retention.sql).

revoke execute on function core.purge_old_events() from authenticated;
grant execute on function core.purge_old_events() to authenticated;

create or replace function core.log_run(
  p_app_id text,
  p_kind text,
  p_wall_clock_ms bigint,
  p_ref text default null
) returns uuid
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_run_id uuid;
begin
  insert into core.run (app_id, kind, ref, status, ended_at)
  values (p_app_id, p_kind, p_ref, 'ok', now())
  returning id into v_run_id;

  insert into core.cost (run_id, wall_clock_ms)
  values (v_run_id, p_wall_clock_ms);

  return v_run_id;
end;
$$;

drop policy owner_rw on idea.score;
create policy authenticated_all on idea.score for all to authenticated using (true) with check (true);

drop policy owner_rw on idea.dependency;
create policy authenticated_all on idea.dependency for all to authenticated using (true) with check (true);

drop policy owner_rw on idea.idea;
create policy authenticated_all on idea.idea for all to authenticated using (true) with check (true);

drop policy owner_rw on core.event_monthly_agg;
create policy authenticated_all on core.event_monthly_agg for all to authenticated using (true) with check (true);

drop policy owner_rw on core.intervention;
create policy authenticated_all on core.intervention for all to authenticated using (true) with check (true);

drop policy owner_rw on core.assumption;
create policy authenticated_all on core.assumption for all to authenticated using (true) with check (true);

drop policy owner_rw on core.metric_value;
create policy authenticated_all on core.metric_value for all to authenticated using (true) with check (true);

drop policy owner_rw on core.metric_def;
create policy authenticated_all on core.metric_def for all to authenticated using (true) with check (true);

drop policy owner_rw on core.run_outcome;
create policy authenticated_all on core.run_outcome for all to authenticated using (true) with check (true);

drop policy owner_rw on core.outcome;
create policy authenticated_all on core.outcome for all to authenticated using (true) with check (true);

drop policy owner_rw on core.cost;
create policy authenticated_all on core.cost for all to authenticated using (true) with check (true);

drop policy owner_rw on core.event;
create policy authenticated_all on core.event for all to authenticated using (true) with check (true);

drop policy owner_rw on core.app;
create policy authenticated_all on core.app for all to authenticated using (true) with check (true);

drop policy owner_rw on core.run;
create policy owner_all on core.run
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
