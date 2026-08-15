-- The up migration's version-1 backfill for pre-SL-004 fixture prompts is
-- deliberately NOT reverted here: those rows are now real version history
-- (readable in the version-history panel), not scaffolding this table's
-- existence depends on. Deleting them on rollback would destroy data this
-- migration only surfaced, not created for its own purposes.
drop table prompt.usage;
