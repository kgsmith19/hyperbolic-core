-- Reverts the registration migration generated for services/brain/tool.json.
-- Does not delete the row (m3-02 acceptance criteria; see
-- 20260814150000_register_llm-handler_down.sql's identical reasoning).
update core.app
set status        = 'idea',
    kind          = 'ui',
    route         = null,
    version       = '0.0.0',
    description   = null,
    manifest      = null,
    manifest_hash = null,
    registered_at = null
where id = 'brain';
