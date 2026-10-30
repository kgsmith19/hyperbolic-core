-- FR-001: the idea registry. Source: topology note section 3, applied verbatim.
create schema if not exists idea;

-- Base Postgres grants; RLS (see rls_baseline) is the actual row-level boundary.
-- Without these, PostgREST gets "permission denied for schema idea" even with
-- correct RLS policies, since GRANT and RLS are independent layers.
grant usage on schema idea to anon, authenticated, service_role;
alter default privileges in schema idea grant all on tables to anon, authenticated, service_role;
alter default privileges in schema idea grant all on sequences to anon, authenticated, service_role;

create table idea.idea (
  id            text primary key,
  name          text not null,
  category      text not null,
  one_liner     text not null,
  problem       text,
  status        text not null default 'idea'
                check (status in ('idea','specced','building','live','parked','killed')),
  app_id        text references core.app(id),
  project       text not null default 'toolbelt',
  schema_name   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table idea.dependency (
  idea_id      text references idea.idea(id) on delete cascade,
  depends_on   text references idea.idea(id) on delete cascade,
  reason       text not null,
  primary key (idea_id, depends_on)
);

create table idea.score (
  id           uuid primary key default gen_random_uuid(),
  idea_id      text not null references idea.idea(id) on delete cascade,
  metric_id    text not null references core.metric_def(id),
  value        numeric not null,
  scored_at    timestamptz not null default now(),
  scored_by    text not null
);
