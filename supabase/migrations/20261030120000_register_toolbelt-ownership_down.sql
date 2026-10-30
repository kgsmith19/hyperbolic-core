-- Restore the registration written by the immediately preceding toolbelt
-- registration (20260814130000_register_toolbelt-v0.1.1.sql). Never delete a core.app row, and never alter
-- status: both survive an application-version rollback.
update core.app
set manifest      = '{"description":"Shared root spine of the Toolbelt monorepo: owns the core schema (runs, costs, outcomes, metrics, events) that every tool writes through via core.log_run, plus the idea schema for the curated portfolio backlog. Not itself a UI or CLI surface.","entry":{"headless":{"command":"select core.purge_old_events();","schedule":"0 3 * * *"}},"id":"toolbelt","kind":"headless","lifecycle":{"health":"node --test \"tests/*.test.mjs\"","migrate":"gh workflow run platform-migrations.yml","register":"20260814130000_register_toolbelt-v0.1.1.sql"},"name":"Toolbelt Root Spine","ownership":{"owner":"kylegsmith19@gmail.com","path":"apps/toolbelt"},"permissions":{"db":{"read":["core","idea"],"write":["core","idea"]},"llmHandler":{"access":false},"networkEgress":[]},"schemas":["core","idea"],"version":"0.1.1"}'::jsonb,
    manifest_hash = '236bcd27eb6241c869db600b462449306f4e3fb2109a2ff738369333d295a865',
    registered_at = now()
where id = 'toolbelt';
