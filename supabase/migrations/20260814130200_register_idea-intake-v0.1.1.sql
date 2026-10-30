-- Additive Idea Intake registry refresh. The earlier registration may already
-- be ledgered and remains immutable; status is never overwritten.
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
  '{"description":"Captures rough ideas as drafts, optionally optimizes them with LLM help, promotes the good ones, and converts each promoted idea into exactly one GitHub Issue that the app can never touch again. Owns the intake schema in the shared toolbelt Supabase project. Supersedes ACC''s Forgepad.","entry":{"ui":{"route":"/ideas"}},"id":"idea-intake","kind":"ui","lifecycle":{"health":"node --test \"tests/*.test.mjs\"","migrate":"gh workflow run platform-migrations.yml","register":"20260814130200_register_idea-intake-v0.1.1.sql"},"name":"Idea Intake","ownership":{"owner":"kylegsmith19@gmail.com","path":"apps/toolbelt/apps/idea-intake"},"permissions":{"db":{"read":["intake"],"write":["intake"]},"llmHandler":{"access":true},"networkEgress":["api.github.com"]},"schemas":["intake"],"version":"0.1.1"}'::jsonb,
  'daac33b2059c02099b933ee5813f24c8d251162fe5070e0cb56ccd0a72535885',
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
