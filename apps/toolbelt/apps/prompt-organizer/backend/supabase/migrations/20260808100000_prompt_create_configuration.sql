-- SPEC-0011 AC-002, AC-003 (FR-008). Same ownership shape as prompt.tag
-- (SR-23): no owner column, RLS via EXISTS against the parent prompt row.
create table prompt.configuration (
  prompt_id  uuid not null references prompt.prompt(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 100),
  values     jsonb not null default '{}'::jsonb,
  sections   text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  primary key (prompt_id, name)
);
grant select, insert on prompt.configuration to authenticated;
alter table prompt.configuration enable row level security;
alter table prompt.configuration force row level security;
create policy owner_select on prompt.configuration for select using (
  exists (select 1 from prompt.prompt p where p.id = prompt_id and p.user_id = auth.uid())
);
create policy owner_insert on prompt.configuration for insert with check (
  exists (select 1 from prompt.prompt p where p.id = prompt_id and p.user_id = auth.uid())
);
