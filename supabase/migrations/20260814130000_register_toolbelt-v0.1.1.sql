-- Additive registration for the root Toolbelt manifest. Historical registry
-- migrations are immutable; this file is the authoritative v0.1.1 refresh.
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
  '{"description":"Shared root spine of the Toolbelt monorepo: owns the core schema (runs, costs, outcomes, metrics, events) that every tool writes through via core.log_run, plus the idea schema for the curated portfolio backlog. Not itself a UI or CLI surface.","entry":{"headless":{"command":"select core.purge_old_events();","schedule":"0 3 * * *"}},"id":"toolbelt","kind":"headless","lifecycle":{"health":"node --test \"tests/*.test.mjs\"","migrate":"gh workflow run platform-migrations.yml","register":"20260814130000_register_toolbelt-v0.1.1.sql"},"name":"Toolbelt Root Spine","ownership":{"owner":"kylegsmith19@gmail.com","path":"apps/toolbelt"},"permissions":{"db":{"read":["core","idea"],"write":["core","idea"]},"llmHandler":{"access":false},"networkEgress":[]},"schemas":["core","idea"],"version":"0.1.1"}'::jsonb,
  '236bcd27eb6241c869db600b462449306f4e3fb2109a2ff738369333d295a865',
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
