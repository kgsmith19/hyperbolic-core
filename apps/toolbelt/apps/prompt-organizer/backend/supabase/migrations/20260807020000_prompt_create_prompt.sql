-- SPEC-0000 AC-001..AC-005. FR-001's bounds live here as CHECK constraints,
-- the cheapest sufficient mechanism. RLS enabled AND forced in the same
-- migration that creates the table, per the topology baseline.
create schema prompt;
grant usage on schema prompt to anon, authenticated, service_role;

create table prompt.prompt (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) default auth.uid(),
  title      text not null check (char_length(title) between 1 and 200),
  body       text not null check (char_length(body) between 1 and 100000),
  created_at timestamptz not null default now()
);

-- Narrowest surface that satisfies FR-001: save and read only. No UPDATE or
-- DELETE grant exists at all until a slice needs one (NFR-005's spirit).
grant select on prompt.prompt to anon, authenticated;
grant insert on prompt.prompt to authenticated;

alter table prompt.prompt enable row level security;
alter table prompt.prompt force row level security;
create policy owner_all on prompt.prompt
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Expose the schema over PostgREST. Prior value read from the live role on
-- 2026-08-07: 'public, core, idea'. The down migration restores it exactly.
alter role authenticator set pgrst.db_schemas = 'public, core, idea, prompt';
notify pgrst, 'reload config';
