# Handler A

`services/llm-handler` -- the deployed general-purpose LLM service
(08-llm-handlers.md forced decisions 5/7). Wraps `@hyperbolic/llm` with
Handler A's own provider keys, owner-session auth, per-caller concurrency
limiting, and `core.llm_call` telemetry logging. Also hosts Idea Intake's
submit API (`/api/intake/submit`, m3-06), pulled forward ahead of Handler
A's own M4 milestone.

TypeScript, ESM, Node 22 (native TypeScript stripping, no build step).
Raw `node:http`, no framework -- a small, security-relevant loopback
service, the same shape as `apps/agentic-command-center/backend/gui/server.mjs`.

## Commands

```bash
npm test --workspace=@hyperbolic/llm-handler        # node --test tests/*.test.ts
npm run typecheck --workspace=@hyperbolic/llm-handler
node src/index.ts                                    # run directly (needs env, see below)
docker build -f services/llm-handler/Dockerfile .     # build context is the monorepo root
```

Required environment: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
`TOOLBELT_GITHUB_INTAKE_PAT`, `SUPABASE_SERVICE_ROLE_KEY`. Optional:
`LLM_HANDLER_PORT` (default `8200`), `LLM_MAX_CONCURRENCY_PER_CALLER`
(default `2`), and any of `LLM_KEYS_ANTHROPIC` / `LLM_KEYS_OPENAI` /
`LLM_KEYS_GEMINI` (each provider is independently optional; a request
naming an unconfigured provider fails per-request, not at boot). See
`src/config.ts` for the full contract.

## Layout

```
src/index.ts           entrypoint: load config, start server
src/server.ts           HTTP routing: /healthz, /api/intake/submit, /api/v1/*
src/auth.ts             ADR-03 owner-session verification
src/concurrency.ts       per-caller concurrency gate
src/llm-routes.ts        /v1/complete, /v1/stream, /v1/count handlers
src/llm-request.ts       request parsing/validation for the /v1/* routes
src/count.ts             token-count estimate (chars/4 heuristic, no provider call)
src/llm-call-log.ts      core.llm_call telemetry writes
src/intake-submit.ts     idea-intake submit orchestration
src/github-client.ts     GitHub issue create/find for intake submit
src/postgrest.ts         PostgREST access on the caller's own bearer token
src/config.ts            env var contract, fails fast at startup
tests/                   node --test suite, one file per src module
```

## Documentation

- `docs/ops/runbook.md`, "Handler A deployment" section -- deploy
  pipeline, required secrets, manual rollback.
- `docs/planning/08-llm-handlers.md` -- Handler A's specifying document
  (forced decisions 5/7, the `/v1/*` route contract).
- `AGENTS.md` in this directory -- invariants and completion criteria for
  changes here.
