# lifeos-ui

React single-page application for the LifeOS FastAPI backend. The deployed
service is tailnet-only and authenticates with Supabase Auth JWTs.

Stack: React 19, strict TypeScript, Vite, Tailwind v4, TanStack Query, React
Router, Vitest with Testing Library, Playwright, oxlint, and Prettier.

Repository-wide guidance and delivery boundaries are in `../AGENTS.md`.

## Product facts

- `../backend/` owns product and architecture decisions.
- `src/api/types.gen.ts` is generated from the backend API and must not be
  hand-edited.
- All HTTP calls go through `src/api/client.ts`; components do not call
  `fetch` or Supabase data APIs directly.
- Pages own routes in `src/pages/`; reusable UI belongs in
  `src/components/`.
- Every `VITE_` value is compiled into the browser bundle. Never put a secret
  in a client environment variable.

## Commands

- Install: `npm ci`
- Develop: `npm run dev`
- Format: `npm run format`
- Lint: `npm run lint`
- Type-check: `npx tsc -b`
- Unit tests: `npm run test`
- Browser tests: `npm run e2e`
- Build: `npm run build`
- Regenerate API types: `npm run gen:api`

Playwright request mocks must be scoped to the configured API host; do not use
a bare `**/path` pattern that can intercept unrelated traffic.

## Engineering guidance

- Prefer the smallest clear change that fully satisfies the linked Issue.
- Reuse existing components and utilities before adding dependencies or layers.
- Delete code made obsolete by the change.
- Add behavior-focused Vitest/component tests and Playwright coverage where
  user-visible flows change.
- Preserve unrelated work and do not weaken tests to make a change pass.

## Work and delivery

GitHub Issues are the durable source for requested work. The root
`../.github/workflows/ci.yml` runs the only merge gate, including frontend
lint, type checks, unit tests, browser tests, and the production build. The
root `release-smoke.yml` remains an independent scheduled/manual deployed-system
test. Follow the delivery and AI contribution boundaries in `../AGENTS.md`.
