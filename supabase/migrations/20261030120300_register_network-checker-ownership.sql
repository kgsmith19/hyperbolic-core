-- Ownership repoint (Phase 2, #520): network-checker's manifest moved from
-- apps/toolbelt/apps/network-checker/ to apps/network-checker/, so its ownership.path
-- is corrected. Forward-only upsert; the registration columns are unchanged.
-- Status is excluded from the conflict update so a lifecycle transition
-- already applied is never overwritten.
insert into core.app (
  id, name, schema_name, status, kind, route, version, description,
  manifest, manifest_hash, registered_at
)
values (
  'network-checker',
  'Network Checker',
  'network-checker',
  'building',
  'cli',
  null,
  '1.0.0',
  'Local-first network diagnostics that identify which layer failed: Wi-Fi, router, modem, ISP, target service, or a specific device. SQLite is the source of truth; Supabase is an optional, separate mirror project for cross-machine history.',
  '{"id":"network-checker","name":"Network Checker","kind":"cli","version":"1.0.0","description":"Local-first network diagnostics that identify which layer failed: Wi-Fi, router, modem, ISP, target service, or a specific device. SQLite is the source of truth; Supabase is an optional, separate mirror project for cross-machine history.","ownership":{"owner":"kylegsmith19@gmail.com","path":"apps/network-checker"},"entry":{"cli":{"command":"python3 -m network_checker"}},"schemas":[],"permissions":{"db":{"read":[],"write":[]},"networkEgress":["1.1.1.1","192.168.50.1","192.168.100.1","239.255.255.250","api.anthropic.com","api.ipify.org","ipapi.co","status.anthropic.com"],"llmHandler":{"access":false}},"lifecycle":{"migrate":"supabase db push","health":"bash tools/check.sh","register":"20261030120300_register_network-checker-ownership.sql"}}'::jsonb,
  '92449c9c026e24614bfbcbc49957a85b5ce1e068d0934b7628f32541a185f283',
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
