-- Restore the exact registry representation written by the immediately
-- preceding Network Checker registration. Never delete a core.app row, and
-- never alter status: both survive an application-version rollback.
update core.app
set name          = 'Network Checker',
    schema_name   = 'netcheck',
    kind          = 'cli',
    route         = null,
    version       = '0.1.0',
    description   = 'Local-first network diagnostics that identify which layer failed: Wi-Fi, router, modem, ISP, target service, or a specific device. SQLite is the source of truth; Supabase is an optional, separate mirror project for cross-machine history.',
    manifest      = '{"id":"network-checker","name":"Network Checker","kind":"cli","version":"0.1.0","description":"Local-first network diagnostics that identify which layer failed: Wi-Fi, router, modem, ISP, target service, or a specific device. SQLite is the source of truth; Supabase is an optional, separate mirror project for cross-machine history.","ownership":{"owner":"kylegsmith19@gmail.com","path":"apps/toolbelt/apps/network-checker"},"entry":{"cli":{"command":"python3 -m netcheck"}},"schemas":[],"permissions":{"db":{"read":[],"write":[]},"networkEgress":["ipapi.co","api.ipify.org","status.anthropic.com","api.anthropic.com","1.1.1.1"],"llmHandler":{"access":false}},"lifecycle":{"migrate":"supabase db push","health":"bash tools/check.sh","register":"20260812250000_register_network-checker.sql"}}'::jsonb,
    manifest_hash = '146e208e509e124d6ca4a74cb0e6f7139acd2fd94c1516078e28c55e5fad2a87',
    registered_at = now()
where id = 'network-checker';
