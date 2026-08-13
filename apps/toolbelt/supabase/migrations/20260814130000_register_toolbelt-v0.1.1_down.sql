-- Restore the v0.1.0 registration represented by the preceding additive
-- root-spine migration; preserve independent lifecycle status.
update core.app
set name          = 'Toolbelt Root Spine',
    schema_name   = 'core',
    kind          = 'headless',
    route         = null,
    version       = '0.1.0',
    description   = 'Shared root spine of the Toolbelt monorepo: owns the core schema (runs, costs, outcomes, metrics, events) that every tool writes through via core.log_run, plus the idea schema for the curated portfolio backlog. Not itself a UI or CLI surface.',
    manifest      = '{"description":"Shared root spine of the Toolbelt monorepo: owns the core schema (runs, costs, outcomes, metrics, events) that every tool writes through via core.log_run, plus the idea schema for the curated portfolio backlog. Not itself a UI or CLI surface.","entry":{"headless":{"command":"select core.purge_old_events();","schedule":"0 3 * * *"}},"id":"toolbelt","kind":"headless","lifecycle":{"health":"node --test \"tests/*.test.mjs\"","migrate":"gh workflow run platform-migrations.yml","register":"20260814110000_register_toolbelt.sql"},"name":"Toolbelt Root Spine","ownership":{"owner":"kylegsmith19@gmail.com","path":"apps/toolbelt"},"permissions":{"db":{"read":["core","idea"],"write":["core","idea"]},"llmHandler":{"access":false},"networkEgress":[]},"schemas":["core","idea"],"version":"0.1.0"}'::jsonb,
    manifest_hash = '9047af64aa7e5db516e2291f9b0bb4777cf4d9f56c2ad7b3f80749fa9f190828',
    registered_at = now()
where id = 'toolbelt';
