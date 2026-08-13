-- PR #8 security review, Finding 1 (P1, merge-blocking): core.log_run's
-- owner gate (added by 20260812160000_core_idea_owner_pin.sql) fails OPEN
-- when no owner is configured yet.
--
-- The bug: `(select auth.uid()) is distinct from (select platform.owner())`
-- uses IS DISTINCT FROM's NULL-tolerant semantics, under which `NULL, NULL`
-- is NOT distinct. Bootstrap state (before the one-time
-- `insert into platform.config ...` documented in
-- docs/notes/2026-08-12-platform-idp-owner-setup.md) has
-- `platform.owner()` returning null. An anonymous PostgREST caller also has
-- `auth.uid()` = null (no JWT). Under those two nulls the guard's own
-- comment claims "fails closed", but IS DISTINCT FROM evaluates
-- `null is distinct from null` = false, so the `raise exception` branch is
-- skipped entirely and the anonymous caller proceeds to insert into
-- core.run/core.cost. This contradicts platform.owner()'s own doc comment
-- (20260812140000_platform_owner_bootstrap.sql: "Fail-closed by
-- construction... every owner-pinned comparison... evaluates false until
-- the operator inserts the one config row") -- true for the RLS policies'
-- plain `=` comparisons (`null = null` is null, not true, so RLS denies),
-- but never true for this function's own hand-rolled IS DISTINCT FROM
-- guard, which needed its own explicit null check to match that same
-- fail-closed contract.
--
-- Reachability: core schema grants USAGE to anon
-- (20260806190000_core_create_schema.sql), and CREATE OR REPLACE FUNCTION
-- preserves a function's existing ACL rather than resetting it -- so the
-- PUBLIC EXECUTE grant Postgres attaches by default at CREATE FUNCTION time
-- (20260807080000_core_log_run_rpc.sql, never revoked since) has survived
-- unchanged through every later `create or replace function core.log_run`,
-- including 20260812160000's. PUBLIC implicitly covers `anon`, so this is
-- reachable today by an unauthenticated `POST /rest/v1/rpc/log_run` call
-- while no owner is configured.
--
-- Fix, additive per the repo's "new migration re-pins/tightens an earlier
-- one" convention (e.g. 20260812180000_prompt_owner_pin.sql):
--   1. Replace the guard with a NULL-safe check: raise whenever
--      platform.owner() IS NULL (no owner configured -- reject, don't fall
--      through), OR the caller is not literally that owner. This is the
--      same fail-closed contract the RLS `=` comparisons already have,
--      made explicit instead of accidentally NULL-tolerant.
--   2. Explicitly revoke the lingering PUBLIC/anon EXECUTE grant. Real
--      caller is `authenticated` (apps/toolbelt/tests/log_run.test.mjs and
--      apps/toolbelt/tests/owner-repin.test.mjs both call
--      `rpc/log_run` with a bearer token, i.e. as `authenticated`; no
--      caller in this repo invokes it anonymously) -- keep that grant,
--      restated explicitly here rather than left implicit, so this
--      migration's own diff shows the complete intended ACL rather than
--      relying on a `CREATE OR REPLACE` carry-over the way the bug above
--      did.
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
  if (select platform.owner()) is null
     or (select auth.uid()) is distinct from (select platform.owner()) then
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

revoke execute on function core.log_run(text, text, bigint, text) from public, anon;
grant execute on function core.log_run(text, text, bigint, text) to authenticated;
