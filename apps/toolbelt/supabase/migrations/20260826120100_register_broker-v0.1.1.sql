-- issue #187 Phase 0 (broker cutover, slice A): the guards broker's
-- v0.1.1 registration refresh -- description only. The prior description
-- ("Log-only pass-through ... No credential injection (#186) ... yet")
-- predated #186/#199/#200 landing and no longer matched the shipped
-- behavior. Historical registry migrations are immutable; this file is the
-- authoritative v0.1.1 refresh, superseding
-- 20260817120000_register_broker.sql.
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
  '0.1.1',
  'The guards broker (Epic #182): a forward proxy on 127.0.0.1:8300 for outbound calls other services make. Authenticates each caller (BROKER_CALLER_TOKEN_<CALLER>), authorizes it against its manifest''s vaultKeys/allowedHosts, and injects the named credential server-side (#186) -- callers never hold provider keys for broker-routed calls. Host-allowlist checks (#187) and budget spend checks (#188/#200) are log-only today: no request is refused on either yet.',
  '{"description":"The guards broker (Epic #182): a forward proxy on 127.0.0.1:8300 for outbound calls other services make. Authenticates each caller (BROKER_CALLER_TOKEN_<CALLER>), authorizes it against its manifest''s vaultKeys/allowedHosts, and injects the named credential server-side (#186) -- callers never hold provider keys for broker-routed calls. Host-allowlist checks (#187) and budget spend checks (#188/#200) are log-only today: no request is refused on either yet.","entry":{"headless":{"command":"node src/index.ts"}},"id":"broker","kind":"headless","lifecycle":{"health":"node --test \"tests/*.test.ts\"","migrate":"none","register":"20260826120100_register_broker-v0.1.1.sql"},"name":"Guards Broker","ownership":{"owner":"kylegsmith19@gmail.com","path":"services/broker"},"permissions":{"db":{"read":[],"write":[]},"llmHandler":{"access":false},"networkEgress":[]},"schemas":[],"version":"0.1.1"}'::jsonb,
  '6e231bd0c6097fcdc2c4c360063f6debfeb9ffa429b0ff146e06d4b2878148be',
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
