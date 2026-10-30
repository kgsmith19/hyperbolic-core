-- Restore the exact registry representation written by the immediately
-- preceding prompt-organizer registration (20260814130100_register_prompt-organizer-v0.1.2.sql). Never delete a core.app row,
-- and never alter status: both survive an application-version rollback.
update core.app
set name          = 'Prompt Organizer',
    schema_name   = 'prompt',
    kind          = 'ui',
    route         = '/prompts',
    version       = '0.1.2',
    description   = 'Stores reusable AI prompts, substitutes variables, and copies rendered text. Owns the prompt schema in the shared toolbelt Supabase project.',
    manifest      = '{"description":"Stores reusable AI prompts, substitutes variables, and copies rendered text. Owns the prompt schema in the shared toolbelt Supabase project.","entry":{"ui":{"route":"/prompts"}},"id":"prompt-organizer","kind":"ui","lifecycle":{"health":"node --test \"tests/*.test.mjs\"","migrate":"gh workflow run platform-migrations.yml","register":"20260814130100_register_prompt-organizer-v0.1.2.sql"},"name":"Prompt Organizer","ownership":{"owner":"kylegsmith19@gmail.com","path":"apps/toolbelt/apps/prompt-organizer"},"permissions":{"db":{"read":["prompt"],"write":["prompt"]},"llmHandler":{"access":false},"networkEgress":[]},"schemas":["prompt"],"version":"0.1.2"}'::jsonb,
    manifest_hash = '27c49fd77e736887502a23d2003a97a0cda27d127bb711151e1f79f643a6d161',
    registered_at = now()
where id = 'prompt-organizer';
