-- Platform single-principal machinery: the `platform` schema, its `config`
-- singleton, and the `platform.owner()` helper every owner-pinned RLS policy
-- calls. Source: docs/planning/06-supabase-schema.md section 5.2, applied
-- verbatim (ADR-03 single-principal design; migration sequence step S1).
--
-- Fail-closed by construction: platform.config starts empty, so
-- platform.owner() returns null and every owner-pinned comparison in later
-- migrations evaluates false until the operator inserts the one config row
-- (a documented one-time step at IdP setup, never a committed migration and
-- never through PostgREST -- see docs/planning/issues/m1-07-...). This
-- migration changes no existing policy: CI stays green (sequence property S1).
create schema platform;
grant usage on schema platform to anon, authenticated, service_role;

create table platform.config (
  singleton   boolean primary key default true check (singleton),
  owner_uuid  uuid not null,
  created_at  timestamptz not null default now()
);

-- Enable WITHOUT force: the table owner (the migration/SQL-editor role)
-- performs the one-time bootstrap insert; API roles have no policy and no
-- grant, so PostgREST can neither read nor write this table.
alter table platform.config enable row level security;
revoke all on platform.config from anon, authenticated;

create function platform.owner() returns uuid
language sql
stable
security definer
set search_path = platform, pg_temp
as $$ select owner_uuid from platform.config $$;

revoke all on function platform.owner() from public;
grant execute on function platform.owner() to anon, authenticated, service_role;

-- Deliberately NOT exposed via PostgREST: pgrst.db_schemas (set in the
-- 20260812150000_test_create_fence migration) omits `platform`. Only SQL
-- policies call platform.owner(); there is no API surface for this schema.
