-- m4-05: Handler A's first registry entry (08-llm-handlers.md forced
-- decision 7, tool.schema.json's ownership.path exception for services/*).
-- schema_name is NOT NULL on core.app, and Handler A owns no schema of its
-- own (it logs through core.log_llm_call, a caller-facing RPC on the
-- toolbelt root's own core.app row, not a schema it authors DDL for) --
-- 'none' reuses this same manifest's own lifecycle.migrate field
-- convention ("or 'none' for schema-less tools", tool.schema.json) for the
-- identical condition, rather than inventing a second sentinel.
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
  '0.1.0',
  'The general-purpose LLM handler (08-llm-handlers.md forced decisions 5/7): wraps packages/llm with the general-purpose provider keys, an HTTP surface (/v1/complete, /v1/stream, /v1/count), and core.llm_call logging. Holds no Brain key and cannot read /brain/ secrets (ADR-05).',
  '{"description":"The general-purpose LLM handler (08-llm-handlers.md forced decisions 5/7): wraps packages/llm with the general-purpose provider keys, an HTTP surface (/v1/complete, /v1/stream, /v1/count), and core.llm_call logging. Holds no Brain key and cannot read /brain/ secrets (ADR-05).","entry":{"headless":{"command":"node src/index.ts"}},"id":"llm-handler","kind":"headless","lifecycle":{"health":"node --test \"tests/*.test.ts\"","migrate":"gh workflow run platform-migrations.yml","register":"20260814150000_register_llm-handler.sql"},"name":"Handler A","ownership":{"owner":"kylegsmith19@gmail.com","path":"services/llm-handler"},"permissions":{"db":{"read":["core"],"write":[]},"llmHandler":{"access":false},"networkEgress":["api.anthropic.com","api.openai.com","generativelanguage.googleapis.com"]},"schemas":[],"version":"0.1.0"}'::jsonb,
  '9e4d71a70b66deb35fa83bcac739e41d4f5bc4c4bc7f50aa54e008a0c35d4023',
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
