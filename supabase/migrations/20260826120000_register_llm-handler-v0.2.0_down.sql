-- Restore the v0.1.0 registration represented by
-- 20260814150000_register_llm-handler.sql (which is immutable history);
-- preserve independent lifecycle status, same shape as
-- 20260814130000_register_toolbelt-v0.1.1_down.sql.
update core.app
set name          = 'Handler A',
    schema_name   = 'none',
    kind          = 'headless',
    route         = null,
    version       = '0.1.0',
    description   = 'The general-purpose LLM handler (08-llm-handlers.md forced decisions 5/7): wraps packages/llm with the general-purpose provider keys, an HTTP surface (/v1/complete, /v1/stream, /v1/count), and core.llm_call logging. Holds no Brain key and cannot read /brain/ secrets (ADR-05).',
    manifest      = '{"description":"The general-purpose LLM handler (08-llm-handlers.md forced decisions 5/7): wraps packages/llm with the general-purpose provider keys, an HTTP surface (/v1/complete, /v1/stream, /v1/count), and core.llm_call logging. Holds no Brain key and cannot read /brain/ secrets (ADR-05).","entry":{"headless":{"command":"node src/index.ts"}},"id":"llm-handler","kind":"headless","lifecycle":{"health":"node --test \"tests/*.test.ts\"","migrate":"gh workflow run platform-migrations.yml","register":"20260814150000_register_llm-handler.sql"},"name":"Handler A","ownership":{"owner":"kylegsmith19@gmail.com","path":"services/llm-handler"},"permissions":{"db":{"read":["core"],"write":[]},"llmHandler":{"access":false},"networkEgress":["api.anthropic.com","api.openai.com","generativelanguage.googleapis.com"]},"schemas":[],"version":"0.1.0"}'::jsonb,
    manifest_hash = '9e4d71a70b66deb35fa83bcac739e41d4f5bc4c4bc7f50aa54e008a0c35d4023',
    registered_at = now()
where id = 'llm-handler';
