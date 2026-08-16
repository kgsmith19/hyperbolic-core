# lifeos-ui

## 🎯 Purpose

React single-page application for the LifeOS FastAPI backend. The deployed service is tailnet-only and authenticates with Supabase Auth JWTs. Stack: React 19, strict TypeScript, Vite, Tailwind v4, TanStack Query, React Router, Vitest with Testing Library, Playwright, oxlint, and Prettier.

## 📋 Product Boundaries

- `../backend/` owns product and architecture decisions.
- `src/api/types.gen.ts` is generated from the backend API and must not be
  hand-edited.
- All HTTP calls go through `src/api/client.ts`; components do not call
  `fetch` or Supabase data APIs directly.
- Pages own routes in `src/pages/`; reusable UI belongs in
  `src/components/`.
- Every `VITE_` value is compiled into the browser bundle. Never put a secret
  in a client environment variable.
- Add behavior-focused Vitest/component tests and Playwright coverage where
  user-visible flows change.

## ⚙️ Commands

```bash
npm ci        # install
npm run dev   # develop
npm run format
npm run lint
npx tsc -b    # type-check
npm run test  # unit tests
npm run e2e   # browser tests
npm run build
npm run gen:api  # regenerate API types
```

Playwright request mocks must be scoped to the configured API host; do not use
a bare `**/path` pattern that can intercept unrelated traffic.

## ✅ Completion Criteria

The merge gate is the repository root's `.github/workflows/lifeos-ci.yml`,
whose frontend job runs lint, type checks, unit tests, browser tests, and the
production build.

## 🔒 Collaboration Boundary

Repository-wide delivery and AI contribution boundaries are defined in `../AGENTS.md`.
