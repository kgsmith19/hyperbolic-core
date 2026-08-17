-- issue #185: the guards broker's first registry entry (Epic #182,
-- tool.schema.json's ownership.path exception for services/*). Like Handler
-- A's own registration (20260814150000_register_llm-handler.sql), the
-- broker owns no schema of its own -- schema_name is NOT NULL on core.app,
-- so 'none' reuses lifecycle.migrate's own "or 'none' for schema-less
-- tools" convention for the identical condition rather than inventing a
-- second sentinel.
insert into core.app (
  id, name, schema_name, status, kind, route, version, description,
  manifest, manifest_hash, registered_at
)
values (
  'broker',
  'Guards Broker',
  'none',
  'building',
  'headless',
  null,
  '0.1.0',
  'The guards broker (Epic #182, issue #185): a forward proxy on 127.0.0.1:8300 for outbound calls other services make. Log-only pass-through in this phase -- logs every proxied request (caller, target host, timestamp) and forwards it unmodified. No credential injection (#186), no egress allowlist enforcement (#187), no budget enforcement (#188) yet.',
  '{"description":"The guards broker (Epic #182, issue #185): a forward proxy on 127.0.0.1:8300 for outbound calls other services make. Log-only pass-through in this phase -- logs every proxied request (caller, target host, timestamp) and forwards it unmodified. No credential injection (#186), no egress allowlist enforcement (#187), no budget enforcement (#188) yet.","entry":{"headless":{"command":"node src/index.ts"}},"id":"broker","kind":"headless","lifecycle":{"health":"node --test \"tests/*.test.ts\"","migrate":"none","register":"20260817120000_register_broker.sql"},"name":"Guards Broker","ownership":{"owner":"kylegsmith19@gmail.com","path":"services/broker"},"permissions":{"db":{"read":[],"write":[]},"llmHandler":{"access":false},"networkEgress":[]},"schemas":[],"version":"0.1.0"}'::jsonb,
  'f109c1db5bc05a345f85ac8f0b057fbc5c93e2ac5a78ea216a053c317635348e',
  now()
)
on conflict (id) do update set
  name          = excluded.name,
  schema_name   = excluded.schema_name,
  kind          = excluded.kind,
  route         = excluded.route,
  version       = excluded.version,
  description   = excluded.description,
  manifest      = excluded.manifest,
  manifest_hash = excluded.manifest_hash,
  registered_at = excluded.registered_at;
