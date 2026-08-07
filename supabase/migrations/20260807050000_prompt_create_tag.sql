-- SPEC-0004 AC-001, AC-002, AC-005, AC-006 (FR-012). Applied by the
-- integrator only, serialized after SL-006's merge.

create table prompt.tag (
  prompt_id uuid not null references prompt.prompt(id) on delete cascade,
  tag       text not null check (char_length(tag) between 1 and 100),
  primary key (prompt_id, tag)
);

-- No delete grant: removing a tag is out of scope this slice (7.1) -- the
-- PRD names only add-and-filter; tags accumulate until a future slice
-- justifies a delete path, same posture as SL-000/SL-004's grant discipline.
grant select, insert on prompt.tag to authenticated;

alter table prompt.tag enable row level security;
alter table prompt.tag force row level security;

-- `tag` carries no user_id of its own (7.1); ownership is via the parent
-- prompt.prompt row, avoiding a redundant column FR-012 does not ask for.
create policy owner_select on prompt.tag
  for select using (
    exists (select 1 from prompt.prompt p where p.id = prompt_id and p.user_id = auth.uid())
  );
create policy owner_insert on prompt.tag
  for insert with check (
    exists (select 1 from prompt.prompt p where p.id = prompt_id and p.user_id = auth.uid())
  );
