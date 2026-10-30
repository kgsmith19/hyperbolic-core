-- Down migration for 20260812150000_test_create_fence.sql.
alter role authenticator set pgrst.db_schemas = 'public, core, idea, prompt';
notify pgrst, 'reload config';
drop policy if exists authenticated_all on test.scratch;
drop table if exists test.scratch;
drop schema if exists test;
