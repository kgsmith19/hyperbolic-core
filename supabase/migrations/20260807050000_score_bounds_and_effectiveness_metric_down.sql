delete from core.metric_def where id = 'idea_effectiveness';

drop trigger score_bounds_check on idea.score;
drop function idea.enforce_score_bounds();

alter table core.metric_def drop constraint metric_def_bounds_ordered;
alter table core.metric_def
  drop column min_value,
  drop column max_value;
