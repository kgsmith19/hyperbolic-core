-- Additive Prompt Organizer registry refresh. The earlier registration may
-- already be ledgered and remains immutable; status is never overwritten.
insert into core.app (
  id, name, schema_name, status, kind, route, version, description,
  manifest, manifest_hash, registered_at
)
values (
  'prompt-organizer',
  'Prompt Organizer',
  'prompt',
  'building',
  'ui',
  '/prompts',
  '0.1.2',
  'Stores reusable AI prompts, substitutes variables, and copies rendered text. Owns the prompt schema in the shared toolbelt Supabase project.',
  '{"description":"Stores reusable AI prompts, substitutes variables, and copies rendered text. Owns the prompt schema in the shared toolbelt Supabase project.","entry":{"ui":{"route":"/prompts"}},"id":"prompt-organizer","kind":"ui","lifecycle":{"health":"node --test \"tests/*.test.mjs\"","migrate":"gh workflow run platform-migrations.yml","register":"20260814130100_register_prompt-organizer-v0.1.2.sql"},"name":"Prompt Organizer","ownership":{"owner":"kylegsmith19@gmail.com","path":"apps/toolbelt/apps/prompt-organizer"},"permissions":{"db":{"read":["prompt"],"write":["prompt"]},"llmHandler":{"access":false},"networkEgress":[]},"schemas":["prompt"],"version":"0.1.2"}'::jsonb,
  '27c49fd77e736887502a23d2003a97a0cda27d127bb711151e1f79f643a6d161',
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
