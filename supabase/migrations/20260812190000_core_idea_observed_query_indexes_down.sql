-- Down migration for 20260812190000_core_idea_observed_query_indexes.sql.
drop index if exists core.event_at;
drop index if exists idea.score_idea;
