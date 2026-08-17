-- Reverts the registration migration generated for services/broker/tool.json.
-- Does not delete the row (m3-02's acceptance criteria: retirement is a
-- generated migration setting status = 'retired', never a delete -- other
-- core tables may already carry a foreign key to core.app.id by the time
-- this down migration is ever actually run). Same posture as
-- 20260814150000_register_llm-handler_down.sql: reverts every column the
-- up migration set back to the bare defaults
-- 20260812230000_core_app_registry_extension.sql established.
update core.app
set status        = 'idea',
    kind          = 'ui',
    route         = null,
    version       = '0.0.0',
    description   = null,
    manifest      = null,
    manifest_hash = null,
    registered_at = null
where id = 'broker';
