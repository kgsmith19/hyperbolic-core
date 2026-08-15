-- Forward-only reconciliation for Idea Intake submission invariants. Keep
-- 20260813002605 immutable: this migration must work whether that earlier
-- version has already been recorded or the whole chain is applied fresh.

-- Non-submitted rows must carry no GitHub submission metadata at all. The
-- original boolean-equivalence check admitted any one- or two-field subset.
alter table intake.idea
  drop constraint if exists submitted_fields_all_or_none;
alter table intake.idea
  add constraint submitted_fields_all_or_none check (
    (status = 'submitted_to_github'
     and github_issue_number is not null
     and github_issue_url is not null
     and submitted_at is not null)
    or
    (status <> 'submitted_to_github'
     and github_issue_number is null
     and github_issue_url is null
     and submitted_at is null)
  ) not valid;
alter table intake.idea
  validate constraint submitted_fields_all_or_none;

-- Reject every partial GitHub metadata write. A one-shot Forgepad import may
-- preserve its source updated_at, but only after an explicit opt-in from a
-- superuser/BYPASSRLS session; ordinary API roles always receive now().
create or replace function intake.guard_idea_update() returns trigger
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

  if new.status <> 'submitted_to_github' and
     (new.github_issue_number is not null
      or new.github_issue_url is not null
      or new.submitted_at is not null) then
    raise exception 'II-1: github fields may be set only by the submit transition';
  end if;

  if current_setting('intake.preserve_updated_at', true) = 'on'
     and exists (
       select 1
       from pg_roles
       where rolname = current_user
         and (rolsuper or rolbypassrls)
     ) then
    new.updated_at := new.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end;
$$;
