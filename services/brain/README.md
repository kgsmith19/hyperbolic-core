# The Brain

`services/brain` -- a long-lived autonomous-coding orchestrator
(07-brain-architecture.md): daemon lifecycle with crash recovery, a
SQLite WAL state store, a DAG scheduler with an N=2 concurrency cap,
`brain.task.v1`/`brain.result.v1` contract schemas, harness adapters
(Claude Code today; Codex/Gemini stubbed), autonomy/approval policy, a
`brain` CLI, and an authenticated HTTP API (owner-session + scoped
agent-token auth, run/task CRUD, lossless SSE event replay).

TypeScript, ESM, Node 22 (native TypeScript stripping, no build step).
Raw `node:http`, no framework, matching `services/llm-handler`'s own
posture.

## Commands

```bash
npm run test --workspace=@hyperbolic/brain          # node --test tests/*.test.ts tests/cli/*.test.ts
npm run typecheck --workspace=@hyperbolic/brain      # typecheck:src (tsc -b) + test tsconfig
node src/index.ts                                     # run the daemon directly
node bin/brain.mjs <verb> [--json]                    # the `brain` CLI (status, run, tasks, approve, ...)
node bin/brain.mjs eval run --json                     # run the eval corpus (services/brain/evals/cases)
node scripts/isolation-check.mjs                        # ADR-05 secret-isolation check
docker build -f services/brain/Dockerfile .             # build context is the monorepo root
```

The daemon has no required environment variable at boot (`config.ts`);
`BRAIN_PORT` defaults to `8100`. A real Anthropic key
(`BRAIN_ANTHROPIC_API_KEY` in production, rendered to
`BRAIN_SECRET_FILE`) is needed only for real harness dispatch, not for
starting the daemon or running the CLI against the store.

## Layout

```
bin/brain.mjs           CLI entrypoint: argv parsing/dispatch only
src/index.ts             daemon entrypoint: config, daemon lifecycle, signal handling
src/server.ts             HTTP surface: /healthz, /api/brain/*
src/daemon.ts             startup/shutdown/crash-recovery lifecycle
src/scheduler.ts          DAG scheduler, N=2 concurrency cap
src/dispatch.ts           worktree + harness dispatch + result mapping
src/adapters/             harness adapters (claude-code, stub, fixture)
src/router.ts             initial/fallback adapter selection
src/autonomy.ts            A0-A3 autonomy levels, always-approve rules
src/approval-gate.ts       scheduler-facing approval decision + parking
src/contracts.ts           brain.task.v1/brain.result.v1 ajv validation
src/schemas/               the JSON Schema files contracts.ts validates against
src/journal.ts             per-run append-only ndjson event journal
src/scrubber.ts            log/prompt secret-shaped-string masking
src/worktree.ts            per-task git worktree lifecycle
src/cli/                   CLI verb logic (pure, store/journal/config-only)
src/evals.ts                eval-case loading/running/capture
evals/cases/                the eval corpus (see its own README.md)
scripts/isolation-check.mjs ADR-05 secret-isolation check (brain-ci.yml)
tests/                      node --test suite, one file per src module
```

## Documentation

- `docs/ops/runbook.md`, "Brain deployment" section -- deploy pipeline,
  required secrets, manual rollback, and the documented `/brain/stream`
  external-reachability gap.
- `evals/cases/README.md` -- the eval corpus format and seed cases.
- `AGENTS.md` in this directory -- invariants and completion criteria for
  changes here.
