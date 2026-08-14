-- m4-08: The Brain's first registry entry (08/07 forced decisions; same
-- services/<id> ownership.path exception m4-05's Handler A registration
-- established). schema_name is NOT NULL on core.app and the Brain owns no
-- Supabase schema of its own (its state store is SQLite, 07 section 7.6;
-- it only mirrors run/cost summaries into core via RPC) -- 'none' reuses
-- this same manifest's own lifecycle.migrate convention for the identical
-- condition.
insert into core.app (
  id, name, schema_name, status, kind, route, version, description,
  manifest, manifest_hash, registered_at
)
values (
  'brain',
  'The Brain',
  'none',
  'building',
  'headless',
  null,
  '0.1.0',
  '07-brain-architecture.md: a long-lived autonomous-coding orchestrator (daemon, SQLite WAL state store, DAG scheduler, crash recovery, brain.task.v1/brain.result.v1 contracts, ACC-kernel-subprocess harness adapters with worktree isolation, autonomy/approval policy, and the full `brain` CLI verb surface). The HTTP API and UI surfaces land in later M4 issues. Holds its own isolated Anthropic key (ADR-05) and cannot read /platform/llm/.',
  '{"description":"07-brain-architecture.md: a long-lived autonomous-coding orchestrator (daemon, SQLite WAL state store, DAG scheduler, crash recovery, brain.task.v1/brain.result.v1 contracts, ACC-kernel-subprocess harness adapters with worktree isolation, autonomy/approval policy, and the full `brain` CLI verb surface). The HTTP API and UI surfaces land in later M4 issues. Holds its own isolated Anthropic key (ADR-05) and cannot read /platform/llm/.","entry":{"headless":{"command":"node src/index.ts"}},"id":"brain","kind":"headless","lifecycle":{"health":"npm test","migrate":"gh workflow run platform-migrations.yml","register":"20260814160000_register_brain.sql"},"name":"The Brain","ownership":{"owner":"kylegsmith19@gmail.com","path":"services/brain"},"permissions":{"db":{"read":["core"],"write":[]},"llmHandler":{"access":false},"networkEgress":["api.anthropic.com","github.com"]},"schemas":[],"version":"0.1.0"}'::jsonb,
  'bd19481d5253be371cabbfa4a766283daebd818ed0326ba58c50ded17f5b0f15',
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
