-- Down migration for 20260812200000_prompt_observed_query_indexes.sql.
drop index if exists prompt.usage_prompt;
drop index if exists prompt.prompt_created_at;
