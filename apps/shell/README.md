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
package.json          workspace member; every script lives here
frontend/src/         app shell, pages, components, and lib helpers
frontend/e2e/         Playwright specs
frontend/test/        standalone check scripts (bundle size, healthz)
```

All frontend work lives under `frontend/`, the same rule every app follows.
There is no `backend/` because this app owns no schema and runs no server:
everything it renders comes from `packages/platform-client`,
`services/llm-handler`, or ACC's loopback API. See `AGENTS.md` for the
boundary and `TEST_LEDGER.md` for the suites.
