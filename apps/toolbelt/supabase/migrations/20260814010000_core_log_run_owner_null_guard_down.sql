-- Down migration for 20260814010000_core_log_run_owner_null_guard.sql.
-- Restores core.log_run's exact pre-fix body (the NULL-tolerant IS
-- DISTINCT FROM guard from 20260812160000_core_idea_owner_pin.sql) and
-- re-grants EXECUTE to PUBLIC, undoing this migration's revoke. Deliberately
-- restores the vulnerable state -- this is a mechanical reversal of exactly
-- what the paired up migration changed, not a security recommendation to
-- ever run it for real.
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
  if (select auth.uid()) is distinct from (select platform.owner()) then
    raise exception 'owner only' using errcode = '42501';
  end if;

  insert into core.run (app_id, kind, ref, status, ended_at)
  values (p_app_id, p_kind, p_ref, 'ok', now())
  returning id into v_run_id;

  insert into core.cost (run_id, wall_clock_ms)
  values (v_run_id, p_wall_clock_ms);

  return v_run_id;
end;
$$;

grant execute on function core.log_run(text, text, bigint, text) to public;
