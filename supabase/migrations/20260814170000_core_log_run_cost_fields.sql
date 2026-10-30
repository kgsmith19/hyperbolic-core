-- m4-17 (07-brain-architecture.md section 7.9 / 7.6's "telemetry mirror,
-- run/cost summaries... via the existing RPC pattern"): extends
-- core.log_run (20260807080000_core_log_run_rpc.sql) with the token/usd
-- parameters that migration's own header comment named as its likely next
-- extension -- "no current caller produces them" was true until now; the
-- Brain is the first caller that does (services/brain/src/core-mirror.ts).
--
-- Same function name, same four original leading parameters in the same
-- order (every existing 4-arg caller keeps working unchanged), four new
-- trailing parameters all defaulted to 0 so a caller that still only
-- passes wall_clock_ms gets exactly today's core.cost row. Dropped and
-- recreated rather than CREATE OR REPLACE: Postgres identifies a function
-- by name plus ordered parameter TYPES, so adding parameters changes the
-- signature and CREATE OR REPLACE alone would leave the old 4-arg
-- function as a second, now-redundant overload rather than replacing it.
drop function core.log_run(text, text, bigint, text);

create function core.log_run(
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

grant execute on function core.log_run(text, text, bigint, text, bigint, bigint, bigint, numeric) to authenticated;

-- The Brain calls this RPC from its own background dispatch path (after a
-- run finishes), not from an inbound HTTP request carrying an owner
-- session JWT the way every other core.* RPC caller so far does -- there
-- is no per-request caller identity to ride at that point. service_role
-- is the credential a headless daemon action uses instead (same posture
-- as services/llm-handler/src/postgrest.ts's writeBackSubmitted, the
-- other system-initiated write in this codebase), so it needs an explicit
-- grant here rather than relying on whatever implicit access service_role
-- already has.
grant execute on function core.log_run(text, text, bigint, text, bigint, bigint, bigint, numeric) to service_role;
