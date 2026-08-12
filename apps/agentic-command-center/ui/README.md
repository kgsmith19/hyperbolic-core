# Agentic Command Center — UI

React UI for ACC. The zero-runtime-dependency core serves a loopback API; this
directory builds to static files that ACC serves same-origin through
`--ui-dist`.

**The API contract is ACC's `gui/README.md`.** `src/api.ts` mirrors it in types; `e2e/contract.spec.ts` proves it against a real ACC server. If ACC changes a route without updating its contract doc, this suite goes red — that is the whole cross-repo coupling.

## Stack

React 19 · Vite 8 · TypeScript 7 (strict) · Tailwind v4 · shadcn/ui on Base UI (nova preset) · React Router 8 · TanStack Query 5 · Lucide. Approved-when-needed (not yet used, so not yet imported): Zustand (client state), Motion (animation), GSAP (heavy animation).

## Run

```bash
npm install
npm run dev        # http://127.0.0.1:5173 — proxies /api to a running ACC server
                   #   (in the ACC repo: npm run gui; override target with ACC_API=)
npm run build      # dist/ — serve via ACC: node gui/server.mjs --ui-dist <this repo>/dist
npm run e2e        # contract suite vs the real sandboxed ACC server
                   #   (ACC_DIR=.. by default from this directory)
```

## Layout

```
src/api.ts               the typed client — one file, mirrors gui/README.md
src/main.tsx             shell: nav, router, query client, dark mode
src/pages/StartWork.tsx  create/route/launch directives, live list, log tails
src/pages/Guards.tsx     toggle, protections, vault, runbox
src/pages/Spending.tsx   tier, dials, emergency stop
src/pages/Kernel.tsx     kernel policy editor
src/components/ui/       shadcn copy-in (Base UI primitives)
e2e/contract.spec.ts     the drift alarm
```

## House rules

Lean first: no state library until a component genuinely needs client state
TanStack Query does not own; no animation library until a screen earns it. The
root `PR Gate` keeps the client and server contract green in the same commit.
ACC's built-in pages remain the fallback until the parity criterion recorded in
ADR-0006 is met.
