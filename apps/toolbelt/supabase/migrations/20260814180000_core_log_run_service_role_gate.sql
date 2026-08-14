-- Two real gaps found while building m6-02 (Shell cost dashboard) in
-- core.log_run as left by 20260814170000_core_log_run_cost_fields.sql.
--
-- 1. SECURITY REGRESSION (re-opens PR #8 Finding 1, closed by
--    20260812160000_core_idea_owner_pin.sql, hardened by
--    20260814010000_core_log_run_owner_null_guard.sql): that migration
--    used `drop function` + `create function` -- a NEW function object,
--    required since adding four trailing params changes the signature --
--    rather than `create or replace`, so Postgres attached its own
--    CREATE-time default ACL (EXECUTE granted to PUBLIC) to the new
--    object, and the function body carried none of the null-safe
--    owner-gate check the two migrations above had spent two rounds
--    getting right. Both are reinstated here, narrowest-first (this
--    repo's own established style, see 20260814010000/20260814060000).
--
-- 2. VISIBILITY BUG: Brain's own background dispatch (services/brain/src/
--    core-mirror.ts) calls this RPC with the service-role key -- there is
--    no per-request owner JWT at that point, so core.run.user_id's own
--    column default (`default auth.uid()`) resolves to null for every
--    Brain-mirrored row. core.run's owner_rw RLS policy
--    (20260812160000) requires `user_id = (select platform.owner())`; a
--    null user_id makes that comparison null, not true, so RLS silently
--    excludes every Brain-mirrored run from the owner's own reads --
--    exactly the rows m6-02's dashboard needs to show. This is a
--    single-owner system (ADR-03): every row this RPC ever writes belongs
--    to the one owner regardless of which credential happened to call it,
--    so user_id is set explicitly here rather than left to a column
--    default that only resolves correctly for one of this RPC's two real
--    caller populations.
--
-- The owner gate must let the Brain's own service-role call through
-- untouched -- service_role has no owner JWT to compare; the service-role
-- key itself is the trust boundary, the same posture
-- intake.mark_submitted_to_github() already established for a
-- service-role-only RPC (apps/toolbelt/apps/idea-intake/supabase/
-- migrations/20260814040000) -- while still closing the hole for every
-- other caller. auth.role() reads the JWT's own role claim, independent
-- of the auth.uid()/session-role machinery a SECURITY DEFINER body would
-- otherwise see (current_user/session_user do not reflect the calling
-- role's own JWT here) -- the standard Supabase mechanism for exactly
-- this distinction.
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
  if (select auth.role()) is distinct from 'service_role' then
    if (select platform.owner()) is null
       or (select auth.uid()) is distinct from (select platform.owner()) then
      raise exception 'owner only' using errcode = '42501';
    end if;
  end if;

  insert into core.run (app_id, kind, ref, status, ended_at, user_id)
  values (p_app_id, p_kind, p_ref, 'ok', now(), (select platform.owner()))
  returning id into v_run_id;

  insert into core.cost (run_id, input_tokens, output_tokens, cache_read_tokens, wall_clock_ms, usd)
  values (v_run_id, coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0), coalesce(p_cache_read_tokens, 0), p_wall_clock_ms, coalesce(p_usd, 0));

  return v_run_id;
end;
$$;

revoke all on function core.log_run(text, text, bigint, text, bigint, bigint, bigint, numeric) from public, anon;
grant execute on function core.log_run(text, text, bigint, text, bigint, bigint, bigint, numeric) to authenticated;
grant execute on function core.log_run(text, text, bigint, text, bigint, bigint, bigint, numeric) to service_role;
