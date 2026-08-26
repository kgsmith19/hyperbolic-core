-- Restore the v0.1.0 registration represented by
-- 20260817120000_register_broker.sql (which is immutable history); preserve
-- independent lifecycle status, same shape as
-- 20260814130000_register_toolbelt-v0.1.1_down.sql.
update core.app
set name          = 'Guards Broker',
    schema_name   = 'none',
    kind          = 'headless',
    route         = null,
    version       = '0.1.0',
    description   = 'The guards broker (Epic #182, issue #185): a forward proxy on 127.0.0.1:8300 for outbound calls other services make. Log-only pass-through in this phase -- logs every proxied request (caller, target host, timestamp) and forwards it unmodified. No credential injection (#186), no egress allowlist enforcement (#187), no budget enforcement (#188) yet.',
    manifest      = '{"description":"The guards broker (Epic #182, issue #185): a forward proxy on 127.0.0.1:8300 for outbound calls other services make. Log-only pass-through in this phase -- logs every proxied request (caller, target host, timestamp) and forwards it unmodified. No credential injection (#186), no egress allowlist enforcement (#187), no budget enforcement (#188) yet.","entry":{"headless":{"command":"node src/index.ts"}},"id":"broker","kind":"headless","lifecycle":{"health":"node --test \"tests/*.test.ts\"","migrate":"none","register":"20260817120000_register_broker.sql"},"name":"Guards Broker","ownership":{"owner":"kylegsmith19@gmail.com","path":"services/broker"},"permissions":{"db":{"read":[],"write":[]},"llmHandler":{"access":false},"networkEgress":[]},"schemas":[],"version":"0.1.0"}'::jsonb,
    manifest_hash = 'f109c1db5bc05a345f85ac8f0b057fbc5c93e2ac5a78ea216a053c317635348e',
    registered_at = now()
where id = 'broker';
