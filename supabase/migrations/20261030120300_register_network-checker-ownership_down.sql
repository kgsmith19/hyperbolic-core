-- Restore the exact registry representation written by the immediately
-- preceding network-checker registration (20260816020000_register_network-checker-v2.sql). Never delete a core.app row,
-- and never alter status: both survive an application-version rollback.
update core.app
set name          = 'Network Checker',
    schema_name   = 'network-checker',
    kind          = 'cli',
    route         = null,
    version       = '1.0.0',
    description   = 'Local-first network diagnostics that identify which layer failed: Wi-Fi, router, modem, ISP, target service, or a specific device. SQLite is the source of truth; Supabase is an optional, separate mirror project for cross-machine history.',
    manifest      = '{"id":"network-checker","name":"Network Checker","kind":"cli","version":"1.0.0","description":"Local-first network diagnostics that identify which layer failed: Wi-Fi, router, modem, ISP, target service, or a specific device. SQLite is the source of truth; Supabase is an optional, separate mirror project for cross-machine history.","ownership":{"owner":"kylegsmith19@gmail.com","path":"apps/toolbelt/apps/network-checker"},"entry":{"cli":{"command":"python3 -m network_checker"}},"schemas":[],"permissions":{"db":{"read":[],"write":[]},"networkEgress":["1.1.1.1","192.168.50.1","192.168.100.1","239.255.255.250","api.anthropic.com","api.ipify.org","ipapi.co","status.anthropic.com"],"llmHandler":{"access":false}},"lifecycle":{"migrate":"supabase db push","health":"bash tools/check.sh","register":"20260816020000_register_network-checker-v2.sql"}}'::jsonb,
    manifest_hash = '289de94aee010a9d542373526cef52751363dfc5eb93f42b0e67cc91ba8b1e29',
    registered_at = now()
where id = 'network-checker';
