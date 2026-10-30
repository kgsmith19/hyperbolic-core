-- Ownership repoint (Phase 2, #520): idea-intake's manifest moved from
-- apps/toolbelt/apps/idea-intake/ to apps/idea-intake/, so its ownership.path
-- is corrected. Forward-only upsert; the registration columns are unchanged.
-- Status is excluded from the conflict update so a lifecycle transition
-- already applied is never overwritten.
insert into core.app (
  id, name, schema_name, status, kind, route, version, description,
  manifest, manifest_hash, registered_at
)
values (
  'idea-intake',
  'Idea Intake',
  'intake',
  'building',
  'ui',
  '/ideas',
  '0.1.1',
  'Captures rough ideas as drafts, optionally optimizes them with LLM help, promotes the good ones, and converts each promoted idea into exactly one GitHub Issue that the app can never touch again. Owns the intake schema in the shared toolbelt Supabase project. Supersedes ACC''s Forgepad.',
  '{"id":"idea-intake","name":"Idea Intake","kind":"ui","version":"0.1.1","description":"Captures rough ideas as drafts, optionally optimizes them with LLM help, promotes the good ones, and converts each promoted idea into exactly one GitHub Issue that the app can never touch again. Owns the intake schema in the shared toolbelt Supabase project. Supersedes ACC''s Forgepad.","ownership":{"owner":"kylegsmith19@gmail.com","path":"apps/idea-intake"},"entry":{"ui":{"route":"/ideas"}},"schemas":["intake"],"permissions":{"db":{"read":["intake"],"write":["intake"]},"networkEgress":["api.github.com"],"llmHandler":{"access":true}},"lifecycle":{"migrate":"gh workflow run platform-migrations.yml","health":"node --test \"tests/*.test.mjs\"","register":"20261030120200_register_idea-intake-ownership.sql"}}'::jsonb,
  '17930a277e4f862b8402571762086ebd20c45abb3b069f64422bf45eaa29f457',
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
