-- Generated registration migration (docs/planning/05-c-toolbelt.md
-- section 4.2) for apps/toolbelt/apps/idea-intake/tool.json, produced by
-- packages/toolbelt-cli's tool:new (m3-03). The shape follows section 4.2's
-- contract exactly: one idempotent upsert of the core.app row from tool.json
-- fields, matching m3-02's hand-written precedent
-- (apps/toolbelt/supabase/migrations/20260812240000_register_prompt-organizer.sql).
--
-- This is a brand-new row: the scaffold CLI's collision check (id taken on
-- disk, id already claimed by a manifest, or id already claimed by an
-- existing *_register_<id>.sql on disk) refuses to generate this migration
-- at all if 'idea-intake' were already registered, so the ON CONFLICT branch below
-- exists only to make a re-run of this same migration safe, never to avoid
-- clobbering someone else's insert (same posture as
-- 20260812250000_register_network-checker.sql). `status` is deliberately
-- absent from the UPDATE SET list: re-running registration must never
-- clobber a status a separate, dedicated status-transition migration set
-- (e.g. a future promotion to 'live', or retirement to 'retired').
--
-- manifest_hash is the sha256 hex digest of the canonicalized manifest
-- (RFC-8785-style key-sorted JSON, no insignificant whitespace), computed by
-- apps/toolbelt/scripts/validate-manifests.mjs's canonicalJSON/manifestHash
-- functions -- imported and called directly by the generator that wrote this
-- file, never reimplemented. apps/toolbelt/apps/idea-intake/tests/registration.test.mjs
-- asserts this literal string equals manifestHash() computed fresh over the
-- real manifest file on disk, so the two can never silently drift apart
-- (TB-1b parity, docs/planning/05-c-toolbelt.md section 11).
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
  '0.1.0',
  'Captures rough ideas as drafts, optionally optimizes them with LLM help, promotes the good ones, and converts each promoted idea into exactly one GitHub Issue that the app can never touch again. Owns the intake schema in the shared toolbelt Supabase project. Supersedes ACC''s Forgepad.',
  '{"id":"idea-intake","name":"Idea Intake","kind":"ui","version":"0.1.0","description":"Captures rough ideas as drafts, optionally optimizes them with LLM help, promotes the good ones, and converts each promoted idea into exactly one GitHub Issue that the app can never touch again. Owns the intake schema in the shared toolbelt Supabase project. Supersedes ACC''s Forgepad.","ownership":{"owner":"kylegsmith19@gmail.com","path":"apps/toolbelt/apps/idea-intake"},"entry":{"ui":{"route":"/ideas"}},"schemas":["intake"],"permissions":{"db":{"read":["intake"],"write":["intake","core"]},"networkEgress":["api.github.com"],"llmHandler":{"access":true}},"lifecycle":{"migrate":"supabase db push","health":"node --test \"tests/*.test.mjs\"","register":"20260813003000_register_idea-intake.sql"}}'::jsonb,
  '8624dbf403ebcc53c8fcf689af94f81a5b10177453a55e6b03d228b1f42378c5',
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
