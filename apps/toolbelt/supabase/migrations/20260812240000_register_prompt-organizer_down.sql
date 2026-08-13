-- Reverts 20260812240000_register_prompt-organizer.sql. Does not touch
-- kind/route (those belong to 20260812230000_core_app_registry_extension.sql's
-- backfill, not this migration -- this migration's own upsert only
-- re-affirmed the same values) and does not delete the row: it pre-dates
-- this migration (20260807040000_register_prompt_organizer.sql), and
-- m3-02's acceptance criteria require that no migration ever delete a
-- core.app row. This reverts exactly the columns this migration's upsert
-- set: version back to the column default,
-- description/manifest/manifest_hash/registered_at back to null.
update core.app
set version       = '0.0.0',
    description   = null,
    manifest      = null,
    manifest_hash = null,
    registered_at = null
where id = 'prompt-organizer';
