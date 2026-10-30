drop function core.log_run(text, text, bigint, text, bigint, bigint, bigint, numeric);

create function core.log_run(
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

grant execute on function core.log_run(text, text, bigint, text) to authenticated;
