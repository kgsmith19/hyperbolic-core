# lifeos-ui

Web UI for lifeos: a React SPA against the FastAPI backend
(https://lifeos-prod.taile48c9b.ts.net, tailnet-only) with Supabase Auth JWTs.

Stack: React 19, TypeScript strict, Vite, Tailwind v4, TanStack Query,
React Router, Vitest + Testing Library, Playwright, oxlint + prettier.

Commands:

- dev: `npm run dev` — http://localhost:5173, sign in with the owner account.
- gate: `npm run lint && npm run test && npm run e2e && npm run build`
- gen:api: `npm run gen:api` — regenerate `src/api/types.gen.ts` whenever the
  backend API changes; commit the result.
- deploy: merge to main → CI gate → dist copied to the VPS →
  https://lifeos-prod.taile48c9b.ts.net:8443

Engineering standards (mirrors the backend repo):

- Simplest solution that fully works; fewest lines that stay clear. Never
  trade functionality for brevity.
- Reuse before adding. No new component, dependency, or layer without a
  present need; delete code a change makes dead.
- Idiomatic current-stack code; oxlint and `tsc -b` gate CI — keep them clean.
- Every behavior change ships with tests: unit/component (Vitest, colocated
  `*.test.tsx`) and e2e (Playwright in `e2e/`, network mocked with
  `page.route` scoped to the API host — never bare `**/path` patterns).
- Merge only on green CI — no server-side branch protection; this rule is the gate.
- All HTTP goes through `src/api/client.ts` (typed by `types.gen.ts`);
  components never call fetch or supabase data APIs directly.
- Pages own routes (`src/pages/`); shared pieces live in `src/components/`.
- `.env` holds only public-by-design values — VITE_ vars are baked into the
  client bundle, so a secret must never appear there.

Review: `/lean-review` (five-lens codebase review).
