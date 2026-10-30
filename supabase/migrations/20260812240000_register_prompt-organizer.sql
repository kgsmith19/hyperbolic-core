-- Generated registration migration (docs/planning/05-c-toolbelt.md section
-- 4.2) for the Prompt Organizer manifest
-- (apps/toolbelt/apps/prompt-organizer/tool.json). Hand-written here because
-- the scaffold CLI that will generate this automatically does not exist yet
-- (m3-03-feat-toolbelt-scaffold-cli.md); the shape follows section 4.2's
-- contract exactly: one idempotent upsert of the core.app row, keyed on id.
--
-- The row already exists (20260807040000_register_prompt_organizer.sql), so
-- this always takes the ON CONFLICT branch in practice; the INSERT branch
-- keeps the migration correct against a fresh database that applies every
-- migration from zero. `status` is deliberately absent from the UPDATE SET
-- list, matching section 4.2 verbatim ("insert ... on conflict (id) do
-- update set name, schema_name, kind, route, version, description,
-- manifest, manifest_hash, registered_at = excluded..."): re-running
-- registration must never clobber a status a separate, dedicated
-- status-transition migration set (e.g. a future promotion to 'live', or
-- retirement to 'retired').
--
-- manifest_hash is the sha256 hex digest of the canonicalized manifest
-- (RFC-8785-style key-sorted JSON, no insignificant whitespace), computed by
-- apps/toolbelt/scripts/validate-manifests.mjs's canonicalJSON/manifestHash
-- functions -- the exact functions this issue requires, not a
-- reimplementation. apps/toolbelt/tests/registry-manifest-hash.test.mjs
-- asserts this literal string equals manifestHash() computed fresh over the
-- real manifest file on disk, so the two can never silently drift apart
-- (TB-1b parity, docs/planning/05-c-toolbelt.md section 11).
insert into core.app (
  id, name, schema_name, status, kind, route, version, description,
  manifest, manifest_hash, registered_at
)
values (
  'prompt-organizer',
  'Prompt Organizer',
  'prompt',
  'building',
  'ui',
  '/prompts',
  '0.1.0',
  'Stores reusable AI prompts, substitutes variables, and copies rendered text. Owns the prompt schema in the shared toolbelt Supabase project.',
  '{"id":"prompt-organizer","name":"Prompt Organizer","kind":"ui","version":"0.1.0","description":"Stores reusable AI prompts, substitutes variables, and copies rendered text. Owns the prompt schema in the shared toolbelt Supabase project.","ownership":{"owner":"kylegsmith19@gmail.com","path":"apps/toolbelt/apps/prompt-organizer"},"entry":{"ui":{"route":"/prompts"}},"schemas":["prompt"],"permissions":{"db":{"read":["prompt"],"write":["prompt","core"]},"networkEgress":[],"llmHandler":{"access":false}},"lifecycle":{"migrate":"gh workflow run platform-migrations.yml","health":"node --test \"tests/*.test.mjs\"","register":"20260812240000_register_prompt-organizer.sql"}}'::jsonb,
  'c73037838b686f7b98e6e81da6dfc4af1137ff6adf82f8abc7311c42f75b527e',
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
