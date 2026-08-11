# lifeos-ui

React single-page application for the LifeOS FastAPI backend. The deployed
service is tailnet-only and authenticates with Supabase Auth JWTs.

Stack: React 19, strict TypeScript, Vite, Tailwind v4, TanStack Query, React
Router, Vitest with Testing Library, Playwright, oxlint, and Prettier.

The shared [agent-engineering-standard](https://github.com/kgsmith19/agent-engineering-standard)
is an experimental, informational reference pinned in `.agent/standard.lock`.
This repository owns its implementation choices and CI.

## Product facts

- The backend repository owns product and architecture decisions.
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

GitHub Issues are the durable source for requested work. Implement one focused
slice on a short-lived branch, run the relevant local checks, and open a pull
request that links the Issue and states the evidence.

`.github/workflows/ci.yml` runs automatically for pull requests. Its workflow
and required check are both named `PR Gate`; it runs lint, type checks, unit
tests, browser tests, and the production build. Native GitHub squash
auto-merge may merge the pull request after repository settings require that
check.

`.github/workflows/release-smoke.yml` is an independent scheduled/manual
test of the deployed UI and backend. It is not a merge gate.

AI coding agents may create branches, commits, Issues, and pull requests only
when explicitly assigned that work. They must not submit code reviews, approve
or block a pull request, request reviewers, or post unsolicited comments. They
may answer in an Issue or pull request only when explicitly mentioned and
asked a direct question.
