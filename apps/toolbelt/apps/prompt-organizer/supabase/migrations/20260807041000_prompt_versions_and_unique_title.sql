-- SPEC-0002 AC-001..AC-004 (FR-002, FR-003, NFR-005). Applied by the
-- integrator only, serialized after SL-001's merge.

-- 1. One-time dedup, destructive to fixtures only: accumulated duplicate-title
--    rows are SL-000 test fixtures (its RISK-002); real data has one user and
--    no duplicates worth keeping. Keeps the earliest row per lower(title).
--    Forced RLS blocks even the table owner (SL-000's mutation drill proved
--    it), so force is lifted for exactly this statement and restored after.
alter table prompt.prompt no force row level security;
delete from prompt.prompt p
  using prompt.prompt earlier
  where lower(earlier.title) = lower(p.title)
    and (earlier.created_at, earlier.id) < (p.created_at, p.id);
alter table prompt.prompt force row level security;

-- 2. FR-002: two prompts never share a title, case-insensitively.
create unique index prompt_title_unique on prompt.prompt (lower(title));

-- 3. FR-003's edit path. Prior value: no UPDATE grant of any kind existed on
--    prompt.prompt before this migration (SL-000 kept the surface at save and
--    read only); the down migration's revoke restores exactly that state.
--    Column-scoped: id, user_id, created_at stay unwritable. The existing
--    owner_all policy already scopes updates to the owner.
grant update (title, body) on prompt.prompt to authenticated;

-- 4. NFR-005: no UPDATE or DELETE grant and no UPDATE or DELETE policy exist
--    on prompt.prompt_version — that pair of absences is the immutability
--    mechanism. RLS enabled and forced in the same migration, per baseline.
create table prompt.prompt_version (
  prompt_id  uuid not null references prompt.prompt(id) on delete cascade,
  version_no integer not null,
  body       text not null,
  user_id    uuid not null,
  created_at timestamptz not null,
  primary key (prompt_id, version_no)
);
grant select, insert on prompt.prompt_version to authenticated;
alter table prompt.prompt_version enable row level security;
alter table prompt.prompt_version force row level security;
create policy owner_select on prompt.prompt_version
  for select using (user_id = auth.uid());
create policy owner_insert on prompt.prompt_version
  for insert with check (user_id = auth.uid());

-- 5. Invoker rights (the default; no security definer): the version insert
--    carries auth.uid() through owner_insert. The distinct-body guard lives
--    in the function because a WHEN clause on an insert-covering trigger
--    cannot reference OLD.
create function prompt.record_version() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.body is not distinct from old.body then
      return new;
    end if;
  end if;
  insert into prompt.prompt_version (prompt_id, version_no, body, user_id, created_at)
  values (
    new.id,
    coalesce((select max(version_no) from prompt.prompt_version
              where prompt_id = new.id), 0) + 1,
    new.body,
    new.user_id,
    now()
  );
  return new;
end;
$$;

create trigger record_version
  after insert or update of body on prompt.prompt
  for each row execute function prompt.record_version();
