-- Ownership repoint (Phase 2, #520): toolbelt's manifest moved from
-- apps/toolbelt/ to the repo root, so its ownership.path
-- is corrected. Forward-only upsert; the registration columns are unchanged.
-- Status is excluded from the conflict update so a lifecycle transition
-- already applied is never overwritten.
insert into core.app (
  id, name, schema_name, status, kind, route, version, description,
  manifest, manifest_hash, registered_at
)
values (
  'toolbelt',
  'Toolbelt Root Spine',
  'core',
  'building',
  'headless',
  null,
  '0.1.1',
  'Shared root spine of the Toolbelt monorepo: owns the core schema (runs, costs, outcomes, metrics, events) that every tool writes through via core.log_run, plus the idea schema for the curated portfolio backlog. Not itself a UI or CLI surface.',
  '{"id":"toolbelt","name":"Toolbelt Root Spine","kind":"headless","version":"0.1.1","description":"Shared root spine of the Toolbelt monorepo: owns the core schema (runs, costs, outcomes, metrics, events) that every tool writes through via core.log_run, plus the idea schema for the curated portfolio backlog. Not itself a UI or CLI surface.","ownership":{"owner":"kylegsmith19@gmail.com","path":"."},"entry":{"headless":{"command":"select core.purge_old_events();","schedule":"0 3 * * *"}},"schemas":["core","idea"],"permissions":{"db":{"read":["core","idea"],"write":["core","idea"]},"networkEgress":[],"llmHandler":{"access":false}},"lifecycle":{"migrate":"gh workflow run platform-migrations.yml","health":"node --test \"tests/spine/*.test.mjs\"","register":"20261030120000_register_toolbelt-ownership.sql"}}'::jsonb,
  '037fb68604c883850fa54cfc3b76d41b73b7e47b5385e8c325514a19b0b0e966',
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
