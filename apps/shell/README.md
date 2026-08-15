# Shell

hyperbolic-core's unified web front end: one React/Vite SPA composing every
zone behind a single owner login.

```bash
npm run dev            # Vite dev server (proxies /api to ACC)
npm run build          # builds packages/ui, then this app
npm run test           # builds packages/ui, then vitest
npm run e2e            # Playwright against a sandboxed server
npm run size-check     # 250 KB gzipped budget
```

## Zones

| Route | Surface |
| --- | --- |
| `/login` | Owner sign-in; the only route outside the auth gate |
| `/` | Home |
| `/tools` | Registry-driven tools list |
| `/ideas` | Idea Intake |
| `/prompts` | Prompt Organizer |
| `/acc` | Agentic Command Center, including the Brain run/chat surface and the cost dashboard |
| `/settings` | Owner settings |

## Layout

```
src/app.tsx        route table and the app shell
src/main.tsx       entry point
src/pages/         one directory per zone
src/components/    shared presentational components
src/lib/           typed clients, hooks, and pure helpers
e2e/               Playwright specs
test/              standalone check scripts (bundle size, healthz)
```

This app is frontend-only. It owns no schema and runs no server: everything it
renders comes from `packages/platform-client`, `services/llm-handler`, or
ACC's loopback API. See `AGENTS.md` for why there is no `backend/` here and
`TEST_LEDGER.md` for the suites.
