-- Issue #200 (buildable slice of #188, budget ledger): the audit ledger a
-- future pre-call spend-check sums against a caller's manifest
-- `maxUsdPerDay` (#184). Modeled directly on core.llm_call
-- (20260814140000_core_llm_call.sql) for the table/RLS shape, and on
-- core.log_run's service-role gate
-- (20260814180000_core_log_run_service_role_gate.sql) /
-- intake.mark_submitted_to_github
-- (20260814040000_intake_mark_submitted_to_github_rpc.sql) for the RPC gate
-- -- but service-role-ONLY, not the owner-JWT-with-service-role-fallback
-- shape core.log_run needs: services/broker has no per-request owner JWT to
-- fall back to at all (it authenticates callers by its own token scheme,
-- issue #186's caller-tokens.ts), so the broker's own service-role key IS
-- the entire trust boundary here, the same posture
-- intake.mark_submitted_to_github already established for its own
-- single-caller-shape RPC.
--
-- core.broker_call has no user_id column (single-owner reference/telemetry
-- table, not per-row-owned) -- Pattern B from
-- 20260812160000_core_idea_owner_pin.sql's own header comment, same as
-- core.llm_call/core.app/core.outcome/core.metric_def.
--
-- No retention/purge function in this migration (unlike core.llm_call's
-- bundled 180-day retention): #200's own scope is the spend-check code
-- path, not a retention policy the owner hasn't specified for this new
-- table yet -- a deliberate scope decision, not an oversight; a retention
-- migration can follow once real spend volume makes one necessary.
create table core.broker_call (
  id          uuid primary key default gen_random_uuid(),
  ts          timestamptz not null default now(),
  caller      text not null,
  target_host text not null,
  cost_usd    numeric(10, 4) not null
);
create index on core.broker_call (caller, ts desc);

alter table core.broker_call enable row level security;
alter table core.broker_call force row level security;
create policy owner_rw on core.broker_call
  for all to authenticated
  using ((select auth.uid()) = (select platform.owner()))
  with check ((select auth.uid()) = (select platform.owner()));

-- Records one broker-proxied call's cost. service_role has BYPASSRLS
-- (Supabase's own default role setup), so this RPC's own auth.role() check
-- is the real gate, not the owner_rw policy above (which exists for a
-- possible future owner-facing dashboard read, matching core.llm_call's own
-- precedent, not for this write path).
create function core.log_broker_call(
  p_caller      text,
  p_target_host text,
  p_cost_usd    numeric
) returns uuid
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_id uuid;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'service_role only' using errcode = '42501';
  end if;

  insert into core.broker_call (caller, target_host, cost_usd)
  values (p_caller, p_target_host, p_cost_usd)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function core.log_broker_call(text, text, numeric) from public, anon, authenticated;
grant execute on function core.log_broker_call(text, text, numeric) to service_role;

-- Sums a caller's logged cost for the current UTC day -- the pre-call
-- spend-check's own read path. A dedicated RPC rather than a raw PostgREST
-- table read (even a service-role-authorized one) to keep the same
-- RPC-only convention core.log_llm_call's own header comment states
-- ("any authenticated tool records a run by calling this RPC instead of
-- ever writing directly into core.run/core.cost") -- reads included, one
-- access pattern for this table, not two.
create function core.broker_call_spend_today(p_caller text) returns numeric
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_total numeric;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'service_role only' using errcode = '42501';
  end if;

  select coalesce(sum(cost_usd), 0) into v_total
  from core.broker_call
  where caller = p_caller
    and ts >= date_trunc('day', now());

  return v_total;
end;
$$;

revoke all on function core.broker_call_spend_today(text) from public, anon, authenticated;
grant execute on function core.broker_call_spend_today(text) to service_role;
