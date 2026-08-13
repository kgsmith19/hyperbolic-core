-- intake schema: intake.idea and intake.optimization, the three guard
-- triggers, column-scoped grants, RLS, and PostgREST exposure. Transcribed
-- from docs/planning/05-h-idea-intake.md sections 1.2 (DDL), 3.1 (trigger
-- RAISE EXCEPTION rule specs), and 3.2 (grants), per m3-05
-- (docs/planning/issues/m3-05-feat-intake-schema.md). This single migration
-- pair supersedes the bare schema skeleton the scaffold CLI (m3-03) would
-- otherwise have generated here: 05-h section 1.2's own DDL block already
-- includes `create schema intake` plus its grants, so that skeleton content
-- is folded into this migration rather than split across two files.
--
-- realizes II-1 (state machine) and II-3 (post-submit immutability) as
-- database properties (docs/planning/03-v1-definition.md section 9).

create schema if not exists intake;
-- deliberately NOT granted to anon: intake is owner-only surface (ADR-03).
grant usage on schema intake to authenticated, service_role;

create table intake.idea (
  id                  uuid primary key default gen_random_uuid(),
  parent_idea_id      uuid references intake.idea(id),
  title               text not null check (char_length(title) between 1 and 200),
  problem             text not null default '',
  outcome             text not null default '',
  notes               text not null default '',
  confidence          text not null default 'medium'
                      check (confidence in ('low','medium','high')),
  status              text not null default 'draft'
                      check (status in ('draft','idea','submitted_to_github')),
  source              text not null default '',
  target_repo         text
                      check (target_repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  idempotency_key     uuid not null unique default gen_random_uuid(),
  github_issue_number integer check (github_issue_number > 0),
  github_issue_url    text,
  submitted_at        timestamptz,
  user_id             uuid not null references auth.users(id) default auth.uid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- github fields exist exactly when submitted: one CHECK binds state to payload
  constraint submitted_fields_all_or_none check (
    (status = 'submitted_to_github')
    = (github_issue_number is not null
       and github_issue_url is not null
       and submitted_at is not null)
  ),
  -- an idea cannot be promoted without a destination repo
  constraint repo_required_beyond_draft check (
    status = 'draft' or target_repo is not null
  )
);

create unique index idea_one_issue_per_repo
  on intake.idea (target_repo, github_issue_number)
  where github_issue_number is not null;
create index idea_parent   on intake.idea (parent_idea_id);
create index idea_status   on intake.idea (status, updated_at desc);

create table intake.optimization (
  id              uuid primary key default gen_random_uuid(),
  input_idea_id   uuid not null references intake.idea(id),
  output_idea_id  uuid references intake.idea(id),
  prompt_name     text not null,
  model           text not null,
  handler_run_id  uuid,
  cost_usd        numeric(12,6) not null default 0,
  created_at      timestamptz not null default now()
);

-- === 3.1 Triggers: the hard rule (submitted rows are structurally
-- immutable) as database properties, not app discipline (II-1, II-3). Body
-- specs transcribed verbatim from 05-h section 3.1; rule order matters
-- (rule 1 fires before rule 2 fires before rule 3).

create function intake.guard_idea_update() returns trigger
language plpgsql as $$
begin
  if old.status = 'submitted_to_github' then
    raise exception 'II-3: submitted ideas are immutable; create a derivative (parent_idea_id) instead';
  end if;

  if (old.status, new.status) not in (
    ('draft','draft'), ('draft','idea'), ('idea','idea'), ('idea','submitted_to_github')
  ) then
    raise exception 'II-1: illegal transition % -> %', old.status, new.status;
  end if;

  if new.status <> 'submitted_to_github' and new.github_issue_number is not null then
    raise exception 'II-1: github fields may be set only by the submit transition';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger idea_guard_update
  before update on intake.idea
  for each row execute function intake.guard_idea_update();

create function intake.guard_idea_delete() returns trigger
language plpgsql as $$
begin
  if old.status = 'submitted_to_github' then
    raise exception 'II-3: submitted ideas cannot be deleted';
  end if;
  return old;
end;
$$;

create trigger idea_guard_delete
  before delete on intake.idea
  for each row execute function intake.guard_idea_delete();

create function intake.guard_idea_insert() returns trigger
language plpgsql as $$
begin
  if new.status <> 'draft' then
    raise exception 'II-1: ideas are born draft';
  end if;

  if new.parent_idea_id is not null and
     (select status from intake.idea where id = new.parent_idea_id) <> 'submitted_to_github' then
    raise exception 'II-3: derivatives fork submitted ideas only; edit unsubmitted ideas in place';
  end if;

  return new;
end;
$$;

create trigger idea_guard_insert
  before insert on intake.idea
  for each row execute function intake.guard_idea_insert();

-- === 3.2 Revoked and column-scoped grants (transcribed verbatim).
-- Consequences (05-h section 3.2): status, idempotency_key, and the github
-- columns are not insertable, so every row is born draft with a
-- server-generated idempotency key and empty github fields; id,
-- idempotency_key, parent_idea_id, user_id, created_at are not updatable by
-- any API caller, ever.

revoke all on intake.idea from anon, authenticated;
grant select on intake.idea to authenticated;
grant insert (parent_idea_id, title, problem, outcome, notes,
              confidence, source, target_repo)
  on intake.idea to authenticated;
grant update (title, problem, outcome, notes, confidence,
              status, target_repo,
              github_issue_number, github_issue_url, submitted_at, updated_at)
  on intake.idea to authenticated;
grant delete on intake.idea to authenticated;

revoke all on intake.optimization from anon, authenticated;
grant select, insert on intake.optimization to authenticated;   -- append-only log

-- RLS: enable + force on both tables; owner policy pinned per ADR-03,
-- matching the platform baseline pattern (m1-08's re-pin convention,
-- apps/toolbelt/supabase/migrations/20260812160000_core_idea_owner_pin.sql):
-- Pattern A (intake.idea carries a real user_id column) checks both the
-- row's own user_id AND the caller against platform.owner(); Pattern B
-- (intake.optimization has no user_id column) checks only the caller.
-- platform.owner() calls stay wrapped in a scalar subquery
-- ((select platform.owner())) throughout, per
-- apps/toolbelt/scripts/validate-migrations.mjs's InitPlan-caching lint.
alter table intake.idea enable row level security;
alter table intake.idea force row level security;
create policy owner_rw on intake.idea
  for all to authenticated
  using (
    user_id = (select platform.owner())
    and (select auth.uid()) = (select platform.owner())
  )
  with check (
    user_id = (select platform.owner())
    and (select auth.uid()) = (select platform.owner())
  );

alter table intake.optimization enable row level security;
alter table intake.optimization force row level security;
create policy owner_rw on intake.optimization
  for all to authenticated
  using ((select auth.uid()) = (select platform.owner()))
  with check ((select auth.uid()) = (select platform.owner()));

-- Expose the schema over PostgREST. Prior value read from the live role's
-- last setter (20260812150000_test_create_fence.sql): 'public, core, idea,
-- prompt, test'. The down migration restores it exactly. Same mechanism
-- Prompt Organizer's own schema-exposure migration used
-- (apps/toolbelt/apps/prompt-organizer/supabase/migrations/20260807020000_prompt_create_prompt.sql).
alter role authenticator set pgrst.db_schemas = 'public, core, idea, prompt, test, intake';
notify pgrst, 'reload config';
