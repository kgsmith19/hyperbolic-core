-- Reverts 20260814110000_register_toolbelt.sql. Does not delete the row
-- (same posture as every other registration down migration in this repo --
-- core.run, core.outcome, core.metric_value, and core.assumption all carry
-- a foreign key to core.app.id, and by the time this down migration is ever
-- actually run, real rows may already reference 'toolbelt'). Instead
-- reverts every column the up migration set back to the bare defaults
-- 20260812230000_core_app_registry_extension.sql established, landing the
-- row in the same "not really registered" shape a fresh pre-manifest insert
-- would have had.
update core.app
set status        = 'idea',
    kind          = 'ui',
    route         = null,
    version       = '0.0.0',
    description   = null,
    manifest      = null,
    manifest_hash = null,
    registered_at = null
where id = 'toolbelt';
