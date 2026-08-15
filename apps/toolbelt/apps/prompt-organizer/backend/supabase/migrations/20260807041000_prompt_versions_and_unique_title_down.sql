-- Reverts 20260807040000_prompt_versions_and_unique_title.sql: removes exactly
-- what it added. The one-time dedup is not reversed by design — it deleted
-- only redundant test-fixture rows (SPEC-0002 AC-005, RISK-002).
drop trigger if exists record_version on prompt.prompt;
drop function if exists prompt.record_version();
drop table if exists prompt.prompt_version;
drop index if exists prompt.prompt_title_unique;
-- Restores the prior state recorded in the up migration: no UPDATE grant of
-- any kind on prompt.prompt.
revoke update (title, body) on prompt.prompt from authenticated;
