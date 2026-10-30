-- The fixture-user fence (SEC-03 remediation). Source:
-- docs/planning/06-supabase-schema.md section 5.3, applied verbatim;
-- migration sequence step S1.
--
-- Fixture users (kylegsmith19+toolbelt-test-a/b@gmail.com) lose all write
-- access to production schemas once the owner re-pin lands
-- (20260812###### core/idea/prompt re-pin migrations, a later step in this
-- sequence). They keep write access ONLY here. Purpose: (a) auth-flow tests
-- prove a fixture token is live by writing a row here; (b) RLS denial tests
-- then prove the SAME token gets zero rows and 4xx on production schemas, so
-- a denial is demonstrably policy, not an expired token.
create schema test;
grant usage on schema test to authenticated;

create table test.scratch (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) default auth.uid(),
  label       text not null default '',
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
grant select, insert, update, delete on test.scratch to authenticated;

alter table test.scratch enable row level security;
alter table test.scratch force row level security;
-- Any authenticated principal may write here; the schema holds nothing real.
-- The fence is one-directional: fixtures write test.*, never core/idea/prompt.
create policy authenticated_all on test.scratch
  for all to authenticated using (true) with check (true);

alter role authenticator set pgrst.db_schemas = 'public, core, idea, prompt, test';
notify pgrst, 'reload config';
