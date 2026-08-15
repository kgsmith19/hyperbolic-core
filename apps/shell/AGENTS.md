# AGENTS.md

## Application purpose

The Shell is hyperbolic-core's unified web front end: one React/Vite SPA that
composes every zone (Tools, Ideas, Prompt Organizer, the ACC area, the Brain
run/chat surface, the cost dashboard) behind a single owner login.

It is **frontend-only by design** — there is no `backend/` here, and that
absence is deliberate rather than an oversight. The Shell owns no schema and
runs no server of its own. Everything it renders comes from a backend that
lives elsewhere and is reached through a typed client:

- `packages/platform-client` — Supabase session, authed fetch, the Brain and
  registry clients.
- `services/llm-handler` — Handler A, the deployed general-purpose service.
- `apps/agentic-command-center/backend/gui/server.mjs` — ACC's loopback API,
  proxied in development.

Because of that, the repo-wide "backend work under `backend/`, frontend work
under `frontend/`" rule has nothing to separate here: `src/` is entirely
frontend. Sibling apps that genuinely have both halves (`apps/lifeos`,
`apps/agentic-command-center`) do carry the split.

## Product boundaries

- Never hold or generate a real owner-identity credential. The Shell
  authenticates the owner through Supabase; tests use fixtures and route
  mocks, never a live owner token.
- The anon/publishable key is the only client key. A service-role key must
  never reach a browser bundle.
- Treat row-level security as the authorization boundary. A UI that hides a
  control is not an authorization decision.
- Keep the gzipped bundle within its 250 KB budget (`npm run size-check`).
  This is load-bearing: it is why `src/lib/prompt-render.ts` is a deliberate,
  parity-tested copy rather than an import of `packages/llm`, whose barrel
  pulls in three provider SDKs.

## Layout

```
src/app.tsx        route table and the app shell
src/main.tsx       entry point
src/pages/         one directory per zone
src/components/    shared presentational components
src/lib/           typed clients, hooks, and pure helpers (each with a
                   colocated *.test.ts)
e2e/               Playwright specs against a real sandboxed server
test/              standalone check scripts (bundle size, healthz)
```

## Commands

```bash
npm run dev                    # Vite dev server, proxies /api to ACC
npm run build                  # builds packages/ui, then this app
npm run test                   # builds packages/ui, then vitest
npm run test:unit              # vitest only (packages/ui already built)
npm run e2e                    # Playwright
npm run size-check             # 250 KB gzipped budget
npm run healthz-check
```

## Completion

A change is ready when its acceptance criteria are satisfied, affected
documentation is accurate, the local checks above pass, and the
`Shell PR Gate` (`.github/workflows/shell-ci.yml`) reports success. That gate
also type-checks and unit-tests `packages/platform-client`, `packages/ui`,
`packages/llm`, and `services/llm-handler`, so a change here can break it via
any of those. State any unverified item explicitly.

## Collaboration boundary

When explicitly assigned, an AI coding agent may create an Issue, branch,
commit, or pull request, and may answer a direct question after an explicit
mention. An AI agent must not submit a review, approve or request reviewers,
block CI/CD, or post unsolicited Issue or pull-request comments.

Preserve unrelated work, do not widen scope silently, and state any validation
that could not be completed.
