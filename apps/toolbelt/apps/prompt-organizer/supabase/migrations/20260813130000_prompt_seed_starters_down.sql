-- Down migration for 20260813130000_prompt_seed_starters.sql. Deletes
-- exactly the seeded titles (case-insensitively, matching the up
-- migration's conflict target), not a namespace-prefix blanket delete: a
-- title the up migration skipped via ON CONFLICT (a pre-existing personal
-- prompt sharing a seeded title) was never actually inserted by this
-- migration, so this down migration's literal title list can remove a
-- same-titled row it did not create if one now exists under that title --
-- the same tradeoff 05-d-prompt-organizer.md section 3 specifies verbatim
-- ("the down migration deletes exactly the seeded titles").
-- prompt.prompt_version rows cascade via the FK's ON DELETE CASCADE
-- (20260807041000); no separate delete is needed there.
alter table prompt.prompt no force row level security;
alter table prompt.prompt_version no force row level security;

delete from prompt.prompt where lower(title) in (
  lower('brain/task-contract'),
  lower('coding/system/kernel-run'),
  lower('coding/review/simplification'),
  lower('planning/spec/issue-outcome'),
  lower('intake/optimize/idea'),
  lower('lifeos/chat/system'),
  lower('research/deep-dive'),
  lower('ops/runbooks/deploy-verify'),
  lower('idea-intake/optimize-v1')
);

alter table prompt.prompt force row level security;
alter table prompt.prompt_version force row level security;
