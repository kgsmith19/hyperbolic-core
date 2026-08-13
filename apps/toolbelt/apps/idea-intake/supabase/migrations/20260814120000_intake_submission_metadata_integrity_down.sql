-- Restore the exact pre-20260814120000 constraint and trigger behavior.

alter table intake.idea
  drop constraint if exists submitted_fields_all_or_none;
alter table intake.idea
  add constraint submitted_fields_all_or_none check (
    (status = 'submitted_to_github')
    = (github_issue_number is not null
       and github_issue_url is not null
       and submitted_at is not null)
  ) not valid;
alter table intake.idea
  validate constraint submitted_fields_all_or_none;

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

  if new.status <> 'submitted_to_github' and new.github_issue_number is not null then
    raise exception 'II-1: github fields may be set only by the submit transition';
  end if;

  new.updated_at := now();
  return new;
end;
$$;
