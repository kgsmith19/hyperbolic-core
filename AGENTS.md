# lifeos-ui

Web UI for lifeos: a React SPA against the FastAPI backend
(https://lifeos-prod.taile48c9b.ts.net, tailnet-only) with Supabase Auth JWTs.

Stack: React 19, TypeScript strict, Vite, Tailwind v4, TanStack Query,
React Router, Vitest + Testing Library, Playwright, oxlint + prettier.

Standard: [agent-engineering-standard](https://github.com/kgsmith19/agent-engineering-standard),
pinned in `.agent/standard.lock`. Repo-specific commands/facts live in
`.agent/project.yaml` — this file is the prose map, that one is the machine
copy; keep them in agreement.

Product truth: this repo has no local PRD or ADRs — it is a thin client over
the `lifeos` backend, which owns product and architecture decisions (its
`docs/adr/`). The backend's API surface is `src/api/types.gen.ts`, generated
by `gen:api` below; treat it as read-only.

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

Work: GitHub Issues are the durable work-item source
(`.github/ISSUE_TEMPLATE/work-item.md`); raw ideas are not work items until
they clear outcome + acceptance criteria. One thin slice at a time, in a
short-lived branch. Define a slice's evidence before writing it — a meaningful
failing test (RED) before the minimum change that turns it green, when a
failing test is possible; coverage is a diagnostic signal, not the goal. Code
without its evidence passing is not done — do not claim completion from
inspection alone.

Risk: R0 (non-behavioral) through R2 (normal product/API change) proceed
autonomously once the gate is green. R3 (auth, secrets, deploy config,
`src/api/client.ts`/`src/auth/`, dependency bumps that change what a
vulnerability scan flags) wants a human look before merge in addition to the
gate; this repo has no R4 (destructive/financial/irreversible) surface today.
An agent may raise a slice's declared risk, never lower it, and must not
change the checks, ruleset, or risk policy governing its own run — that is a
separately authorized change. See `.agent/project.yaml` for the default and
protected paths.

Review: `/lean-review` (five-lens codebase review).
