# AGENTS.md

## 🎯 Purpose

`services/llm-handler` is Handler A: the deployed, general-purpose LLM
service (08-llm-handlers.md forced decisions 5/7). It wraps
`@hyperbolic/llm` with its own provider credentials behind an
owner-session-authenticated HTTP surface (`/api/v1/complete`,
`/api/v1/stream`, `/api/v1/count`), and separately hosts Idea Intake's
submit API (`/api/intake/submit`). It is a real deployable container, not
a library -- distinct from the small shared packages under `packages/`.

## 📋 Product Boundaries / Invariants

- Never hold or use `SUPABASE_SERVICE_ROLE_KEY` for anything but calling
  `intake.mark_submitted_to_github()`. Every other database read/write
  rides the caller's own session JWT through PostgREST, scoped by
  `owner_rw` RLS -- the same authorization boundary the browser gets
  directly.
- Every `/api/v1/*` route goes through `requireOwnerSession` before
  reaching its handler. This is structural (one dispatch table in
  `server.ts`), not per-route repetition, so a new route cannot be added
  with the auth gate accidentally left off.
- ADR-05 key isolation: Handler A holds no Brain key and cannot read
  `/brain/` secrets (`tool.json`). Its own provider keys
  (`LLM_KEYS_ANTHROPIC`/`LLM_KEYS_OPENAI`/`LLM_KEYS_GEMINI`) are each
  independently optional -- a deploy missing one still starts; a request
  naming an unconfigured provider fails per-request, not at boot.
  `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `TOOLBELT_GITHUB_INTAKE_PAT`,
  and `SUPABASE_SERVICE_ROLE_KEY` are required at startup and fail fast.
- The Brain never calls this service. Per 08's forced decision 5, the
  Brain links `packages/llm` in-process with its own isolated key --
  there is no legitimate bare `/v1/*` loopback caller to support besides
  Handler A's own owner-session-authenticated routes.
- `/v1/count` is a budget-awareness estimate (chars/4 heuristic), never
  an exact provider token count, and must stay labeled as such.
- The per-caller concurrency cap (`ConcurrencyGate`, default 2) is
  in-memory only, matching this service's single-replica deployment. Do
  not treat it as a distributed rate limit.
- `/healthz` (bare) and `/api/healthz` (prefixed) must both keep working
  and stay unauthenticated: the bare path is the loopback Docker
  healthcheck, the prefixed path is what a tailscale-serve-mounted
  request actually resolves to (the full incoming path forwards
  unchanged, it does not strip `/api/`).

## 📂 Layout

```
src/index.ts           entrypoint: load config, start server
src/server.ts           HTTP routing and the owner-session dispatch table
src/auth.ts             ADR-03 owner-session verification
src/concurrency.ts       per-caller concurrency gate
src/llm-routes.ts        /v1/complete, /v1/stream, /v1/count handlers
src/llm-request.ts       request parsing/validation for the /v1/* routes
src/count.ts             token-count estimate
src/llm-call-log.ts      core.llm_call telemetry writes
src/intake-submit.ts     idea-intake submit orchestration
src/github-client.ts     GitHub issue create/find for intake submit
src/postgrest.ts         PostgREST access on the caller's own bearer token
src/config.ts            env var contract
tests/                   node --test suite
```

## ⚙️ Commands

```bash
npm test --workspace=@hyperbolic/llm-handler
npm run typecheck --workspace=@hyperbolic/llm-handler
node src/index.ts
docker build -f services/llm-handler/Dockerfile .   # context is the monorepo root
```

## 📚 Documentation

`docs/ops/runbook.md`'s "Handler A deployment" section covers the deploy
pipeline, required Infisical secrets (`/platform/llm-handler/`), and
manual rollback.

## ✅ Completion

A change is ready when its acceptance criteria are satisfied, affected
documentation is accurate, the commands above pass locally, and the
`Platform` reports success --
that workflow, not a dedicated `llm-handler-ci.yml`, is what
type-checks and unit-tests this service on every PR. State any
unverified item explicitly.

## 🔒 Collaboration Boundary

When explicitly assigned, an AI coding agent may create an Issue, branch,
commit, or pull request, and may answer a direct question after an explicit
mention. An AI agent must not submit a review, approve or request reviewers,
block CI/CD, or post unsolicited Issue or pull-request comments.

Preserve unrelated work, do not widen scope silently, and state any validation
that could not be completed.
