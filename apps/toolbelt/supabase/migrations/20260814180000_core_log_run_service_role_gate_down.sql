-- Down migration for 20260814180000_core_log_run_service_role_gate.sql.
-- Restores core.log_run's exact pre-fix body (no owner gate, user_id left
-- to its auth.uid() column default) and re-grants EXECUTE to public,
-- undoing this migration's revoke. Deliberately restores the
-- vulnerable/invisible-row state -- this is a mechanical reversal of
-- exactly what the paired up migration changed, not a recommendation to
-- ever run it for real.
create or replace function core.log_run(
  p_app_id text,
  p_kind text,
  p_wall_clock_ms bigint,
  p_ref text default null,
  p_input_tokens bigint default 0,
  p_output_tokens bigint default 0,
  p_cache_read_tokens bigint default 0,
  p_usd numeric default 0
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

  insert into core.cost (run_id, input_tokens, output_tokens, cache_read_tokens, wall_clock_ms, usd)
  values (v_run_id, coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0), coalesce(p_cache_read_tokens, 0), p_wall_clock_ms, coalesce(p_usd, 0));

  return v_run_id;
end;
$$;

grant execute on function core.log_run(text, text, bigint, text, bigint, bigint, bigint, numeric) to public;
