-- Observed-query indexes for the core/idea-owned half of
-- docs/planning/06-supabase-schema.md section 6 (Q4, Q9). The prompt-owned
-- half (Q1, Q3) is 20260812200000_prompt_observed_query_indexes.sql in the
-- Prompt Organizer's own migrations directory: 06's illustrative SQL block
-- groups all four indexes under one "platform_observed_query_indexes"
-- filename, but they span three schemas owned by two different tools, so
-- this migration set follows the same schema-ownership split section 4.1
-- and section 7.2 already establish everywhere else ("One writer of DDL per
-- schema"), rather than that one block's literal single-file grouping.
create index score_idea on idea.score (idea_id, scored_at desc); -- Q4; per-idea score reads
create index event_at   on core.event (at);                      -- Q9; purge scan
