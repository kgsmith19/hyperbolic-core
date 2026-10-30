-- Reverts 20260807020000_prompt_create_prompt.sql: removes exactly what it
-- added and restores pgrst.db_schemas to its prior recorded value.
drop table if exists prompt.prompt;
drop schema if exists prompt;
alter role authenticator set pgrst.db_schemas = 'public, core, idea';
notify pgrst, 'reload config';
