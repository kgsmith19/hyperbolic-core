-- Reverts 20260812250000_register_network-checker.sql. Does not delete the
-- row even though this migration is what created it: m3-02's acceptance
-- criteria require that no migration ever delete a core.app row (mirroring
-- docs/planning/05-c-toolbelt.md section 4.2's "retirement is a generated
-- migration setting status = 'retired', never a delete" -- core.run,
-- core.outcome, core.metric_value, and core.assumption all carry a foreign
-- key to core.app.id, and by the time this down migration is ever actually
-- run, real rows may already reference 'network-checker'). Instead this
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
where id = 'network-checker';
