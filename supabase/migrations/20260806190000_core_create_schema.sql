-- FR-003: the core schema every tool in the portfolio writes to.
-- Source: docs/notes/2026-08-06-supabase-project-topology.md section 2, applied verbatim.
create schema if not exists core;

-- Base Postgres grants; RLS (see rls_baseline) is the actual row-level boundary.
-- Without these, PostgREST gets "permission denied for schema core" even with
-- correct RLS policies, since GRANT and RLS are independent layers.
grant usage on schema core to anon, authenticated, service_role;
alter default privileges in schema core grant all on tables to anon, authenticated, service_role;
alter default privileges in schema core grant all on sequences to anon, authenticated, service_role;

create table core.app (
  id            text primary key,
  name          text not null,
  schema_name   text not null,
  status        text not null default 'idea'
                check (status in ('idea','building','live','retired')),
  created_at    timestamptz not null default now()
);

create table core.run (
  id            uuid primary key default gen_random_uuid(),
  app_id        text not null references core.app(id),
  kind          text not null,
  ref           text,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  status        text not null default 'running'
                check (status in ('running','ok','failed','halted')),
  user_id       uuid references auth.users(id) default auth.uid()
);
create index on core.run (app_id, started_at desc);

create table core.event (
  id            bigint generated always as identity primary key,
  run_id        uuid not null references core.run(id) on delete cascade,
  parent_id     bigint references core.event(id),
  at            timestamptz not null default now(),
  kind          text not null,
  name          text not null,
  payload       jsonb not null default '{}'::jsonb
);
create index on core.event (run_id, at);
create index on core.event using gin (payload jsonb_path_ops);

create table core.cost (
  run_id            uuid primary key references core.run(id) on delete cascade,
  input_tokens      bigint not null default 0,
  output_tokens     bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  llm_calls         int    not null default 0,
  tool_calls        int    not null default 0,
  wall_clock_ms     bigint not null default 0,
  interventions     int    not null default 0,
  usd               numeric(12,6) not null default 0
);

create table core.outcome (
  id            uuid primary key default gen_random_uuid(),
  app_id        text not null references core.app(id),
  kind          text not null,
  ref           text not null,
  shipped_at    timestamptz not null default now(),
  value_note    text
);

create table core.run_outcome (
  run_id      uuid references core.run(id) on delete cascade,
  outcome_id  uuid references core.outcome(id) on delete cascade,
  primary key (run_id, outcome_id)
);

create table core.metric_def (
  id             text primary key,
  name           text not null,
  formula        text not null,
  unit           text not null,
  is_proxy       boolean not null default false,
  gaming_risk    text not null,
  supersedes     text references core.metric_def(id),
  created_at     timestamptz not null default now()
);

create table core.metric_value (
  metric_id   text not null references core.metric_def(id),
  app_id      text references core.app(id),
  at          timestamptz not null default now(),
  value       numeric not null,
  "window"    text,
  primary key (metric_id, app_id, at)
);

create table core.assumption (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid references core.run(id) on delete set null,
  app_id        text references core.app(id),
  statement     text not null,
  why_needed    text not null,
  how_to_verify text not null,
  blast_radius  text not null check (blast_radius in ('low','medium','high')),
  status        text not null default 'unverified'
                check (status in ('unverified','verified','false')),
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

create table core.intervention (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references core.run(id) on delete cascade,
  at             timestamptz not null default now(),
  decision_type  text not null,
  was_halt       boolean not null,
  was_correction boolean not null,
  note           text
);
