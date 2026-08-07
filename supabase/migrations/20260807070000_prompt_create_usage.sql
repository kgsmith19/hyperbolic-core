-- 0. One-time backfill, fixture debris only: 21 prompts created between
--    02:13 and 02:48 UTC on 2026-08-07 (SL-000/SL-002 era) have zero
--    prompt.prompt_version rows, because SL-004's versioning trigger did
--    not exist yet when they were inserted. Every prompt created since
--    (SL-004 onward, this migration's 07:00 included) already has at least
--    one -- the trigger fires unconditionally on insert. Without this,
--    prompt.usage's composite FK below could never accept a usage row for
--    any of these 21 prompts, and the client's version-embed query
--    (SPEC-0008 7.2) would crash reading an empty array. Found live via
--    the browser drill, not guessed; backfills version 1 from each
--    prompt's own current body -- same "make the invariant actually true"
--    precedent SPEC-0002's duplicate-title dedup already set for this
--    table. Idempotent: re-running inserts nothing once every prompt has
--    a version row.
insert into prompt.prompt_version (prompt_id, version_no, body, user_id, created_at)
select p.id, 1, p.body, p.user_id, p.created_at
from prompt.prompt p
where not exists (select 1 from prompt.prompt_version v where v.prompt_id = p.id);

-- SPEC-0008 (SL-007), FR-011: a usage row per copy, naming the prompt id,
-- the version copied, and when. Composite FK to prompt_version, not just
-- prompt: a usage row must name a version that actually existed, the
-- cheapest mechanism that keeps history honest (rules/00-CORE.md
-- principle 1). config_name stays nullable -- FR-008 (named configurations)
-- is not-started, so nothing exists yet for a user to have selected.
--
-- Deliberately not built here: NFR-010's core.run/core.cost write. This
-- repo's CLAUDE.md forbids writing to any schema but prompt, which NFR-010
-- as worded requires -- a real, unresolved contradiction in this PRD, not
-- something a migration can silently reconcile. See SPEC-0008 section 2.1.
create table prompt.usage (
  id          uuid primary key default gen_random_uuid(),
  prompt_id   uuid not null,
  version_no  integer not null,
  config_name text,
  user_id     uuid not null default auth.uid(),
  created_at  timestamptz not null default now(),
  foreign key (prompt_id, version_no)
    references prompt.prompt_version(prompt_id, version_no)
    on delete cascade
);

grant select, insert on prompt.usage to authenticated;
-- No update or delete grant: usage is an append-only log, same posture as
-- prompt.prompt_version (NFR-005's durability principle, extended here).

alter table prompt.usage enable row level security;
alter table prompt.usage force row level security;
create policy owner_select on prompt.usage
  for select using (user_id = auth.uid());
create policy owner_insert on prompt.usage
  for insert with check (user_id = auth.uid());
