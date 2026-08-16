-- Restore the exact registry representation written by the immediately
-- preceding Network Checker registration (v1). Never delete a core.app row,
-- and never alter status: both survive an application-version rollback.
update core.app
set name          = 'Network Checker',
    schema_name   = 'netcheck',
    kind          = 'cli',
    route         = null,
    version       = '1.0.0',
    description   = 'Local-first network diagnostics that identify which layer failed: Wi-Fi, router, modem, ISP, target service, or a specific device. SQLite is the source of truth; Supabase is an optional, separate mirror project for cross-machine history.',
    manifest      = '{"id":"network-checker","name":"Network Checker","kind":"cli","version":"1.0.0","description":"Local-first network diagnostics that identify which layer failed: Wi-Fi, router, modem, ISP, target service, or a specific device. SQLite is the source of truth; Supabase is an optional, separate mirror project for cross-machine history.","ownership":{"owner":"kylegsmith19@gmail.com","path":"apps/toolbelt/apps/network-checker"},"entry":{"cli":{"command":"python3 -m netcheck"}},"schemas":[],"permissions":{"db":{"read":[],"write":[]},"networkEgress":["1.1.1.1","192.168.50.1","192.168.100.1","239.255.255.250","api.anthropic.com","api.ipify.org","ipapi.co","status.anthropic.com"],"llmHandler":{"access":false}},"lifecycle":{"migrate":"supabase db push","health":"bash tools/check.sh","register":"20260813173000_register_network-checker-v1.sql"}}'::jsonb,
    manifest_hash = 'c91d77d5817cf77e535bccc17f34033ac942387555af669be2120b46eda3f21a',
    registered_at = now()
where id = 'network-checker';
