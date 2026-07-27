---
name: lean-review
description: Review the codebase (or given paths) against AGENTS.md engineering standards — simplicity, clean code, security, tests, size/structure. Reports findings, applies only clear wins, verifies with the full gate.
---

# Lean review

Review `src/` and `e2e/` (or the paths passed as arguments) against the
Engineering standards in AGENTS.md. Same functionality, better code.

Pass every file through five lenses:

1. **Simplicity (KISS)** — can the same behavior ship with less? Dead code,
   needless abstraction or indirection, speculative generality, duplication.
2. **Clean code** — names say what things are; each component does one thing;
   comments state only what code cannot; idiomatic React 19 / TS strict.
3. **Security** — all HTTP through `src/api/client.ts`; no secrets in VITE_
   vars, code, or fixtures; auth state only via supabase-js session.
4. **Tests** — every behavior has a test at the right tier (Vitest colocated,
   Playwright e2e with host-scoped route mocks); tests assert behavior, not
   implementation.
5. **Size & structure** — small components, files under ~150 lines, no new
   file whose job two existing files already cover.

Rules of engagement:

- List findings first (`file:line` — what, why, fix), ranked by value; state
  clean files as clean.
- Apply only clear wins. Skip churn: renames without payoff, style-only diffs.
- Never trade functionality for brevity.
- Gate before any commit: `npm run lint && npm run test && npm run e2e &&
npm run build` — all green, then PR; merge only on green CI.
