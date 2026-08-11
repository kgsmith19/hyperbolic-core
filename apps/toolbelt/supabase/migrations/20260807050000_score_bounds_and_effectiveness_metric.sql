-- FR-004, FR-005: idea effectiveness scoring. A composite score across
-- multiple metrics is future work (Kyle, 2026-08-07); this defines one
-- proxy metric, out of 10, and enforces its declared range on every
-- idea.score row that references it.

-- FR-005: idea.score.value must be checked against its metric's declared
-- range. A CHECK constraint cannot look up another table, so the range is
-- stored here, on the metric definition, and enforced below by a trigger on
-- idea.score. Null on either side means that side is unbounded.
alter table core.metric_def
  add column min_value numeric,
  add column max_value numeric;

alter table core.metric_def
  add constraint metric_def_bounds_ordered
  check (min_value is null or max_value is null or min_value <= max_value);

create function idea.enforce_score_bounds() returns trigger as $$
declare
  lo numeric;
  hi numeric;
begin
  select min_value, max_value into lo, hi
  from core.metric_def
  where id = new.metric_id;

  if lo is not null and new.value < lo then
    raise exception 'value % is below metric %''s minimum %', new.value, new.metric_id, lo
      using errcode = '23514'; -- check_violation
  end if;

  if hi is not null and new.value > hi then
    raise exception 'value % is above metric %''s maximum %', new.value, new.metric_id, hi
      using errcode = '23514';
  end if;

  return new;
end;
$$ language plpgsql;

create trigger score_bounds_check
  before insert or update on idea.score
  for each row
  execute function idea.enforce_score_bounds();

-- FR-004: the rubric ideas are scored against today. A proxy judgment score
-- (is_proxy = true), to be superseded by a measured metric once live
-- tracking data exists (core.metric_def.supersedes) -- Kyle, 2026-08-07.
-- Wording is this implementer's draft; see SPEC-0001 ASM-006.
insert into core.metric_def (id, name, formula, unit, is_proxy, gaming_risk, min_value, max_value)
values (
  'idea_effectiveness',
  'Idea effectiveness',
  'Human judgment of how well the idea solves its stated problem, out of 10',
  'points (0-10)',
  true,
  'A high score with no supporting evidence looks identical to a well-reasoned one. Mitigated by is_proxy = true flagging it as judgment rather than measurement, and by idea.score.scored_by/scored_at recording who scored it and when.',
  0,
  10
);
