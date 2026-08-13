-- Down migration for 20260813160000_prompt_seed_starters.sql. Deletes
-- exactly the migration-owned UUIDs from the up migration. The title-based
-- conflict rule may skip a pre-existing personal row; deleting by UUID means
-- rollback cannot remove that skipped row (or a later same-titled row).
-- prompt.prompt_version rows cascade via the FK's ON DELETE CASCADE
-- (20260807041000); no separate delete is needed there.
alter table prompt.prompt no force row level security;
alter table prompt.prompt_version no force row level security;

delete from prompt.prompt where id in (
  '7a6c6f00-0001-4000-8000-000000000001'::uuid,
  '7a6c6f00-0002-4000-8000-000000000002'::uuid,
  '7a6c6f00-0003-4000-8000-000000000003'::uuid,
  '7a6c6f00-0004-4000-8000-000000000004'::uuid,
  '7a6c6f00-0005-4000-8000-000000000005'::uuid,
  '7a6c6f00-0006-4000-8000-000000000006'::uuid,
  '7a6c6f00-0007-4000-8000-000000000007'::uuid,
  '7a6c6f00-0008-4000-8000-000000000008'::uuid,
  '7a6c6f00-0009-4000-8000-000000000009'::uuid
);

alter table prompt.prompt force row level security;
alter table prompt.prompt_version force row level security;
