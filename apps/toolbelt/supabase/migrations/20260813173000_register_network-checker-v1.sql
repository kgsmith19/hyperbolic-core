-- Forward-only registry refresh for Network Checker 1.0.0. The original
-- 20260812250000 registration may already be in the shared migration ledger
-- and therefore remains immutable. Status is intentionally omitted from the
-- conflict update so registration never overwrites an independent lifecycle
-- transition.
insert into core.app (
  id, name, schema_name, status, kind, route, version, description,
  manifest, manifest_hash, registered_at
)
values (
  'network-checker',
  'Network Checker',
  'netcheck',
  'building',
  'cli',
  null,
  '1.0.0',
  'Local-first network diagnostics that identify which layer failed: Wi-Fi, router, modem, ISP, target service, or a specific device. SQLite is the source of truth; Supabase is an optional, separate mirror project for cross-machine history.',
  '{"id":"network-checker","name":"Network Checker","kind":"cli","version":"1.0.0","description":"Local-first network diagnostics that identify which layer failed: Wi-Fi, router, modem, ISP, target service, or a specific device. SQLite is the source of truth; Supabase is an optional, separate mirror project for cross-machine history.","ownership":{"owner":"kylegsmith19@gmail.com","path":"apps/toolbelt/apps/network-checker"},"entry":{"cli":{"command":"python3 -m netcheck"}},"schemas":[],"permissions":{"db":{"read":[],"write":[]},"networkEgress":["1.1.1.1","192.168.50.1","192.168.100.1","239.255.255.250","api.anthropic.com","api.ipify.org","ipapi.co","status.anthropic.com"],"llmHandler":{"access":false}},"lifecycle":{"migrate":"supabase db push","health":"bash tools/check.sh","register":"20260813173000_register_network-checker-v1.sql"}}'::jsonb,
  'c91d77d5817cf77e535bccc17f34033ac942387555af669be2120b46eda3f21a',
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
