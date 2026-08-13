-- Restore the exact registration represented by the prior historical
-- Idea Intake migration; preserve independent lifecycle status.
update core.app
set name          = 'Idea Intake',
    schema_name   = 'intake',
    kind          = 'ui',
    route         = '/ideas',
    version       = '0.1.0',
    description   = 'Captures rough ideas as drafts, optionally optimizes them with LLM help, promotes the good ones, and converts each promoted idea into exactly one GitHub Issue that the app can never touch again. Owns the intake schema in the shared toolbelt Supabase project. Supersedes ACC''s Forgepad.',
    manifest      = '{"id":"idea-intake","name":"Idea Intake","kind":"ui","version":"0.1.0","description":"Captures rough ideas as drafts, optionally optimizes them with LLM help, promotes the good ones, and converts each promoted idea into exactly one GitHub Issue that the app can never touch again. Owns the intake schema in the shared toolbelt Supabase project. Supersedes ACC''s Forgepad.","ownership":{"owner":"kylegsmith19@gmail.com","path":"apps/toolbelt/apps/idea-intake"},"entry":{"ui":{"route":"/ideas"}},"schemas":["intake"],"permissions":{"db":{"read":["intake"],"write":["intake","core"]},"networkEgress":["api.github.com"],"llmHandler":{"access":true}},"lifecycle":{"migrate":"supabase db push","health":"node --test \"tests/*.test.mjs\"","register":"20260813003000_register_idea-intake.sql"}}'::jsonb,
    manifest_hash = '8624dbf403ebcc53c8fcf689af94f81a5b10177453a55e6b03d228b1f42378c5',
    registered_at = now()
where id = 'idea-intake';
