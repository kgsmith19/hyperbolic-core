-- Ownership repoint (Phase 2, #520): prompt-organizer's manifest moved from
-- apps/toolbelt/apps/prompt-organizer/ to apps/prompt-organizer/, so its ownership.path
-- is corrected. Forward-only upsert; the registration columns are unchanged.
-- Status is excluded from the conflict update so a lifecycle transition
-- already applied is never overwritten.
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
  '{"id":"prompt-organizer","name":"Prompt Organizer","kind":"ui","version":"0.1.2","description":"Stores reusable AI prompts, substitutes variables, and copies rendered text. Owns the prompt schema in the shared toolbelt Supabase project.","ownership":{"owner":"kylegsmith19@gmail.com","path":"apps/prompt-organizer"},"entry":{"ui":{"route":"/prompts"}},"schemas":["prompt"],"permissions":{"db":{"read":["prompt"],"write":["prompt"]},"networkEgress":[],"llmHandler":{"access":false}},"lifecycle":{"migrate":"gh workflow run platform-migrations.yml","health":"node --test \"tests/*.test.mjs\"","register":"20261030120100_register_prompt-organizer-ownership.sql"}}'::jsonb,
  '132247c7d720c8751451108fd61eeb73685dff9a9f9d44cd5472cdb04727ed30',
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
