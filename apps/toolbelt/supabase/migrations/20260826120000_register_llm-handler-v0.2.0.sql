-- issue #187 Phase 0 (broker cutover, slice A): Handler A's v0.2.0
-- registration refresh. The manifest now declares
-- permissions.vaultKeys = ["LLM_KEYS_ANTHROPIC"] -- the credential the
-- guards broker injects server-side for llm-handler's broker-routed
-- /api/v1/complete Anthropic calls (#186's injection code, activated by
-- this declaration once BROKER_URL/BROKER_CALLER_TOKEN are provisioned).
-- Historical registry migrations are immutable; this file is the
-- authoritative v0.2.0 refresh, superseding
-- 20260814150000_register_llm-handler.sql (same additive-upsert shape as
-- 20260814130000_register_toolbelt-v0.1.1.sql).
insert into core.app (
  id, name, schema_name, status, kind, route, version, description,
  manifest, manifest_hash, registered_at
)
values (
  'llm-handler',
  'Handler A',
  'none',
  'building',
  'headless',
  null,
  '0.2.0',
  'The general-purpose LLM handler (08-llm-handlers.md forced decisions 5/7): wraps packages/llm with the general-purpose provider keys, an HTTP surface (/v1/complete, /v1/stream, /v1/count), and core.llm_call logging. Holds no Brain key and cannot read /brain/ secrets (ADR-05).',
  '{"description":"The general-purpose LLM handler (08-llm-handlers.md forced decisions 5/7): wraps packages/llm with the general-purpose provider keys, an HTTP surface (/v1/complete, /v1/stream, /v1/count), and core.llm_call logging. Holds no Brain key and cannot read /brain/ secrets (ADR-05).","entry":{"headless":{"command":"node src/index.ts"}},"id":"llm-handler","kind":"headless","lifecycle":{"health":"node --test \"tests/*.test.ts\"","migrate":"gh workflow run platform-migrations.yml","register":"20260826120000_register_llm-handler-v0.2.0.sql"},"name":"Handler A","ownership":{"owner":"kylegsmith19@gmail.com","path":"services/llm-handler"},"permissions":{"db":{"read":["core"],"write":[]},"llmHandler":{"access":false},"networkEgress":["api.anthropic.com","api.openai.com","generativelanguage.googleapis.com"],"vaultKeys":["LLM_KEYS_ANTHROPIC"]},"schemas":[],"version":"0.2.0"}'::jsonb,
  'ff52a1833a68d4323f1ed2d41a9a44b5f9112551a00305c6775f6b6daef67574',
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
