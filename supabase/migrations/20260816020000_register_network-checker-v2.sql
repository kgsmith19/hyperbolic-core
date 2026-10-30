-- Forward-only registry refresh: the `netcheck` package/CLI was renamed to
-- `network_checker` (the `netcheck` directory name was never liked and the
-- CLI invocation now matches the app's own folder name exactly). This
-- migration is purely a registry-data correction -- `schema_name` was always
-- a nominal identifier with no real `netcheck` schema behind it (see
-- 20260812250000's own comment), so renaming it here changes no schema,
-- table, or grant. Status is intentionally omitted from the conflict update
-- so registration never overwrites an independent lifecycle transition.
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
  '{"id":"network-checker","name":"Network Checker","kind":"cli","version":"1.0.0","description":"Local-first network diagnostics that identify which layer failed: Wi-Fi, router, modem, ISP, target service, or a specific device. SQLite is the source of truth; Supabase is an optional, separate mirror project for cross-machine history.","ownership":{"owner":"kylegsmith19@gmail.com","path":"apps/toolbelt/apps/network-checker"},"entry":{"cli":{"command":"python3 -m network_checker"}},"schemas":[],"permissions":{"db":{"read":[],"write":[]},"networkEgress":["1.1.1.1","192.168.50.1","192.168.100.1","239.255.255.250","api.anthropic.com","api.ipify.org","ipapi.co","status.anthropic.com"],"llmHandler":{"access":false}},"lifecycle":{"migrate":"supabase db push","health":"bash tools/check.sh","register":"20260816020000_register_network-checker-v2.sql"}}'::jsonb,
  '289de94aee010a9d542373526cef52751363dfc5eb93f42b0e67cc91ba8b1e29',
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
