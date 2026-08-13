-- Re-pins every core/idea RLS policy from "any authenticated caller" to the
-- single owner UUID (ADR-03 single-principal design; SEC-03 remediation).
-- Source: docs/planning/06-supabase-schema.md section 5.5, applied verbatim;
-- migration sequence step S4. Depends on platform.owner() existing
-- (20260812140000) and on the CI owner-credential switch already being
-- merged and green (m1-07, sequence step S3) -- see
-- apps/toolbelt/docs/notes/2026-08-12-platform-idp-owner-setup.md for the
-- operator prerequisite this migration assumes is already satisfied before
-- it is ever applied for real.
--
-- Every owner()/auth.uid() reference is wrapped in a scalar subquery
-- ((select ...)) so Postgres evaluates it once per statement as an InitPlan
-- rather than once per row (section 5.6); apps/toolbelt/scripts/validate-migrations.mjs
-- lints for bare platform.owner() calls in CI.

-- Pattern A: core.run carries user_id.
drop policy owner_all on core.run;
create policy owner_rw on core.run
  for all to authenticated
  using (
    user_id = (select platform.owner())
    and (select auth.uid()) = (select platform.owner())
  )
  with check (
    user_id = (select platform.owner())
    and (select auth.uid()) = (select platform.owner())
  );

-- Pattern B: single-owner reference/telemetry tables, no user_id column.
drop policy authenticated_all on core.app;
create policy owner_rw on core.app
  for all to authenticated
  using ((select auth.uid()) = (select platform.owner()))
  with check ((select auth.uid()) = (select platform.owner()));

drop policy authenticated_all on core.event;
create policy owner_rw on core.event
  for all to authenticated
  using ((select auth.uid()) = (select platform.owner()))
  with check ((select auth.uid()) = (select platform.owner()));

drop policy authenticated_all on core.cost;
create policy owner_rw on core.cost
  for all to authenticated
  using ((select auth.uid()) = (select platform.owner()))
  with check ((select auth.uid()) = (select platform.owner()));

drop policy authenticated_all on core.outcome;
create policy owner_rw on core.outcome
  for all to authenticated
  using ((select auth.uid()) = (select platform.owner()))
  with check ((select auth.uid()) = (select platform.owner()));

drop policy authenticated_all on core.run_outcome;
create policy owner_rw on core.run_outcome
  for all to authenticated
  using ((select auth.uid()) = (select platform.owner()))
  with check ((select auth.uid()) = (select platform.owner()));

drop policy authenticated_all on core.metric_def;
create policy owner_rw on core.metric_def
  for all to authenticated
  using ((select auth.uid()) = (select platform.owner()))
  with check ((select auth.uid()) = (select platform.owner()));

drop policy authenticated_all on core.metric_value;
create policy owner_rw on core.metric_value
  for all to authenticated
  using ((select auth.uid()) = (select platform.owner()))
  with check ((select auth.uid()) = (select platform.owner()));

drop policy authenticated_all on core.assumption;
create policy owner_rw on core.assumption
  for all to authenticated
  using ((select auth.uid()) = (select platform.owner()))
  with check ((select auth.uid()) = (select platform.owner()));

drop policy authenticated_all on core.intervention;
create policy owner_rw on core.intervention
  for all to authenticated
  using ((select auth.uid()) = (select platform.owner()))
  with check ((select auth.uid()) = (select platform.owner()));

drop policy authenticated_all on core.event_monthly_agg;
create policy owner_rw on core.event_monthly_agg
  for all to authenticated
  using ((select auth.uid()) = (select platform.owner()))
  with check ((select auth.uid()) = (select platform.owner()));

drop policy authenticated_all on idea.idea;
create policy owner_rw on idea.idea
  for all to authenticated
  using ((select auth.uid()) = (select platform.owner()))
  with check ((select auth.uid()) = (select platform.owner()));

drop policy authenticated_all on idea.dependency;
create policy owner_rw on idea.dependency
  for all to authenticated
  using ((select auth.uid()) = (select platform.owner()))
  with check ((select auth.uid()) = (select platform.owner()));

drop policy authenticated_all on idea.score;
create policy owner_rw on idea.score
  for all to authenticated
  using ((select auth.uid()) = (select platform.owner()))
  with check ((select auth.uid()) = (select platform.owner()));

-- Security definer gates: RLS does not constrain security definer functions,
-- so both must gate themselves explicitly or a fixture token could still
-- write core.run/core.cost through core.log_run after the policy re-pin above.

-- core.log_run: same signature and body as 20260807080000, with an owner
-- gate as the first statement. CREATE OR REPLACE preserves the function's
-- existing "grant execute ... to authenticated" (Postgres does not drop
-- privileges on a same-signature replace), so no re-grant is needed here.
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

-- core.purge_old_events: cron-only from here on. The pg_cron job
-- (20260808120000) runs as the scheduling role, not as "authenticated",
-- and is unaffected by this revoke.
revoke execute on function core.purge_old_events() from authenticated;
