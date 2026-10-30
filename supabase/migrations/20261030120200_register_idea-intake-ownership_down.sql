-- Restore the exact registry representation written by the immediately
-- preceding idea-intake registration (20260814130200_register_idea-intake-v0.1.1.sql). Never delete a core.app row,
-- and never alter status: both survive an application-version rollback.
update core.app
set name          = 'Idea Intake',
    schema_name   = 'intake',
    kind          = 'ui',
    route         = '/ideas',
    version       = '0.1.1',
    description   = 'Captures rough ideas as drafts, optionally optimizes them with LLM help, promotes the good ones, and converts each promoted idea into exactly one GitHub Issue that the app can never touch again. Owns the intake schema in the shared toolbelt Supabase project. Supersedes ACC''s Forgepad.',
    manifest      = '{"description":"Captures rough ideas as drafts, optionally optimizes them with LLM help, promotes the good ones, and converts each promoted idea into exactly one GitHub Issue that the app can never touch again. Owns the intake schema in the shared toolbelt Supabase project. Supersedes ACC''s Forgepad.","entry":{"ui":{"route":"/ideas"}},"id":"idea-intake","kind":"ui","lifecycle":{"health":"node --test \"tests/*.test.mjs\"","migrate":"gh workflow run platform-migrations.yml","register":"20260814130200_register_idea-intake-v0.1.1.sql"},"name":"Idea Intake","ownership":{"owner":"kylegsmith19@gmail.com","path":"apps/toolbelt/apps/idea-intake"},"permissions":{"db":{"read":["intake"],"write":["intake"]},"llmHandler":{"access":true},"networkEgress":["api.github.com"]},"schemas":["intake"],"version":"0.1.1"}'::jsonb,
    manifest_hash = 'daac33b2059c02099b933ee5813f24c8d251162fe5070e0cb56ccd0a72535885',
    registered_at = now()
where id = 'idea-intake';
