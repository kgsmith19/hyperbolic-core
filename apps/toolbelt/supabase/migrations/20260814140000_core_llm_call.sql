-- m4-05: Handler A's call-logging table (08-llm-handlers.md section 6,
-- schema applied verbatim) plus its 180-day retention (section 6's own
-- "Retention" bullet), bundled into one migration -- same bundling
-- precedent as prompt.usage's own retention migration
-- (20260812210000_prompt_usage_retention.sql, table + monthly agg + purge
-- function + cron.schedule all in one file).
--
-- Writer path: Handler A never holds the service-role key on any /v1/*
-- code path (services/llm-handler/src/config.ts's own comment on
-- SUPABASE_SERVICE_ROLE_KEY). It rides the caller's own bearer token
-- through core.log_llm_call() instead -- the same FR-007 convention
-- core.log_run() already established ("any authenticated tool records a
-- run by calling this RPC instead of ever writing directly into
-- core.run/core.cost", 20260807080000_core_log_run_rpc.sql). RLS does not
-- constrain a SECURITY DEFINER function, so the RPC gates itself first
-- (core.is_platform_owner(), matching core.log_run's own post-owner-repin
-- shape in 20260812160000_core_idea_owner_pin.sql) -- today's only real
-- caller is the platform owner session Handler A's own auth.ts already
-- verified before ever reaching this RPC; a future scoped agent token
-- (08 section 5's "or scoped agent token (llm:call)") is a Handler A
-- auth-layer change, not a change to this RPC's owner gate.
--
-- core.llm_call has no user_id column (single-owner reference/telemetry
-- table, not per-row-owned) -- Pattern B from
-- 20260812160000_core_idea_owner_pin.sql's own header comment, same as
-- core.app/core.outcome/core.metric_def.
create table core.llm_call (
  id                 uuid primary key default gen_random_uuid(),
  ts                 timestamptz not null default now(),
  caller_app         text not null,
  purpose            text not null,
  run_ref            text,
  provider           text not null check (provider in ('anthropic','openai','gemini')),
  model              text not null,
  input_tokens       integer not null default 0,
  output_tokens      integer not null default 0,
  cache_read_tokens  integer not null default 0,
  usd_estimate       numeric(10,4),
  latency_ms         integer,
  status             text not null check (status in ('ok','error')),
  error_class        text
);
create index on core.llm_call (caller_app, ts desc);
create index on core.llm_call (run_ref) where run_ref is not null;

alter table core.llm_call enable row level security;
alter table core.llm_call force row level security;
create policy owner_rw on core.llm_call
  for all to authenticated
  using ((select auth.uid()) = (select platform.owner()))
  with check ((select auth.uid()) = (select platform.owner()));

create function core.log_llm_call(
  p_caller_app         text,
  p_purpose            text,
  p_provider           text,
  p_model              text,
  p_status             text,
  p_run_ref            text default null,
  p_input_tokens       integer default 0,
  p_output_tokens      integer default 0,
  p_cache_read_tokens  integer default 0,
  p_usd_estimate       numeric default null,
  p_latency_ms         integer default null,
  p_error_class        text default null
) returns uuid
language plpgsql
security definer
set search_path = core, platform, pg_temp
as $$
declare
  v_id uuid;
begin
  if (select auth.uid()) is distinct from (select platform.owner()) then
    raise exception 'owner only' using errcode = '42501';
  end if;

  insert into core.llm_call (
    caller_app, purpose, run_ref, provider, model,
    input_tokens, output_tokens, cache_read_tokens,
    usd_estimate, latency_ms, status, error_class
  ) values (
    p_caller_app, p_purpose, p_run_ref, p_provider, p_model,
    coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0), coalesce(p_cache_read_tokens, 0),
    p_usd_estimate, p_latency_ms, p_status, p_error_class
  ) returning id into v_id;

  return v_id;
end;
$$;

-- Revoke-then-grant, narrowest first (house style: PUBLIC gets EXECUTE by
-- default at CREATE FUNCTION time, per this session's own PR #8 findings on
-- core.purge_old_events/prompt.purge_old_usage forgetting exactly this
-- step -- stripped in the SAME migration that creates the function here,
-- not left for a later revoke-public follow-up).
revoke all on function core.log_llm_call(text, text, text, text, text, text, integer, integer, integer, numeric, integer, text) from public;
grant execute on function core.log_llm_call(text, text, text, text, text, text, integer, integer, integer, numeric, integer, text) to authenticated;

-- Retention: 180 days hot, monthly call-count aggregate kept forever (08
-- section 6's "Retention" bullet), same atomic single-statement
-- delete-then-aggregate shape as core.purge_old_events' own fix
-- (20260814070000_core_event_retention_atomic.sql) applied from the start
-- here rather than shipped as a later correction -- the double-count bug
-- that migration fixed applies identically to any purge function that
-- aggregates and deletes as two separate statements.
create table core.llm_call_monthly_agg (
  month      date not null primary key,
  call_count bigint not null default 0
);
alter table core.llm_call_monthly_agg enable row level security;
alter table core.llm_call_monthly_agg force row level security;
create policy owner_rw on core.llm_call_monthly_agg
  for all to authenticated
  using ((select auth.uid()) = (select platform.owner()))
  with check ((select auth.uid()) = (select platform.owner()));

create function core.purge_old_llm_calls() returns bigint
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_purged bigint;
begin
  with deleted as (
    delete from core.llm_call
    where ts < now() - interval '180 days'
    returning ts
  ),
  aggregated as (
    insert into core.llm_call_monthly_agg (month, call_count)
    select date_trunc('month', ts)::date, count(*)
    from deleted
    group by 1
    on conflict (month) do update
      set call_count = core.llm_call_monthly_agg.call_count + excluded.call_count
  )
  select count(*) into v_purged from deleted;

  return v_purged;
end;
$$;

-- Cron-only from creation: the pg_cron job below runs as the
-- migration-applying superuser connection, never a PostgREST API role, so
-- revoking every API-reachable grant here (rather than in a later
-- follow-up migration, PR #8's Finding 2 pattern) leaves the real job fully
-- intact while never opening an anonymous purge path.
revoke all on function core.purge_old_llm_calls() from public, anon, authenticated;

select cron.schedule(
  'core-purge-old-llm-calls',
  '30 3 * * *',
  $$select core.purge_old_llm_calls();$$
);
