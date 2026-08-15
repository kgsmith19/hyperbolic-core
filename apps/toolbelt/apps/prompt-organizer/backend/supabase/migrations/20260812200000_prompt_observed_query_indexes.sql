-- Observed-query indexes for the prompt-owned half of
-- docs/planning/06-supabase-schema.md section 6 (Q1, Q3). See
-- 20260812190000_core_idea_observed_query_indexes.sql (toolbelt root) for
-- the schema-ownership-split rationale.
create index prompt_created_at on prompt.prompt (user_id, created_at desc); -- Q1; leads with the RLS predicate column
create index usage_prompt      on prompt.usage (prompt_id);                 -- Q3; badge counts + FK child side
