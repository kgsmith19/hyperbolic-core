-- Generated registration migration (docs/planning/05-c-toolbelt.md section
-- 4.2) for the Network Checker manifest
-- (apps/toolbelt/apps/network-checker/tool.json). Hand-written here because
-- the scaffold CLI that will generate this automatically does not exist yet
-- (m3-03-feat-toolbelt-scaffold-cli.md).
--
-- Network Checker owns no schema inside the shared toolbelt Supabase
-- project (apps/toolbelt/docs/notes/2026-08-06-supabase-project-topology.md
-- Recommendation table: "netcheck, marketmind | leave alone | their own
-- products | Real products with their own users stay separate"). Its
-- SQLite store is the source of truth and its optional Supabase mirror is a
-- deliberately separate project: confirmed by both
-- .github/workflows/platform-migrations.yml (which pushes only the toolbelt
-- root, Prompt Organizer, and Idea Intake migration directories) and
-- apps/toolbelt/scripts/validate-migrations.mjs's MIGRATION_DIRS (the same
-- three; network-checker's own supabase/migrations/ is absent from both).
-- core.app.schema_name is NOT NULL with no carve-out for a schema-less
-- registrant, so 'netcheck' is recorded here as a nominal identifier
-- (matching its own canonical CLI module name,
-- docs/planning/00-canonical-names.md) rather than a claim that a
-- `netcheck` schema exists in this project -- it does not, and
-- apps/toolbelt/apps/network-checker/tool.json's own `schemas` array is
-- empty for the same reason.
--
-- This is a brand-new row: unlike Prompt Organizer, no earlier migration
-- ever inserted a network-checker row into core.app, so the ON CONFLICT
-- branch below exists only to make a re-run of this same migration safe,
-- never to avoid clobbering someone else's insert. `status` is deliberately
-- absent from the UPDATE SET list for the same reason given in
-- 20260812240000_register_prompt-organizer.sql: re-running registration
-- must never clobber a status a separate, dedicated migration set.
--
-- manifest_hash is the sha256 hex digest of the canonicalized manifest,
-- computed by apps/toolbelt/scripts/validate-manifests.mjs's
-- canonicalJSON/manifestHash functions (the exact functions this issue
-- requires). apps/toolbelt/tests/registry-manifest-hash.test.mjs asserts
-- this literal string equals manifestHash() computed fresh over the real
-- manifest file on disk (TB-1b parity).
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
  '0.1.0',
  'Local-first network diagnostics that identify which layer failed: Wi-Fi, router, modem, ISP, target service, or a specific device. SQLite is the source of truth; Supabase is an optional, separate mirror project for cross-machine history.',
  '{"id":"network-checker","name":"Network Checker","kind":"cli","version":"0.1.0","description":"Local-first network diagnostics that identify which layer failed: Wi-Fi, router, modem, ISP, target service, or a specific device. SQLite is the source of truth; Supabase is an optional, separate mirror project for cross-machine history.","ownership":{"owner":"kylegsmith19@gmail.com","path":"apps/toolbelt/apps/network-checker"},"entry":{"cli":{"command":"python3 -m netcheck"}},"schemas":[],"permissions":{"db":{"read":[],"write":[]},"networkEgress":["ipapi.co","api.ipify.org","status.anthropic.com","api.anthropic.com","1.1.1.1"],"llmHandler":{"access":false}},"lifecycle":{"migrate":"supabase db push","health":"bash tools/check.sh","register":"20260812250000_register_network-checker.sql"}}'::jsonb,
  '146e208e509e124d6ca4a74cb0e6f7139acd2fd94c1516078e28c55e5fad2a87',
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
