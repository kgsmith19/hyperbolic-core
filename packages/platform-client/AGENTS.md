# AGENTS.md

## 🎯 Purpose

`@hyperbolic/platform-client` is the shared platform session client (ADR-03): Supabase Auth-backed sign-in and authed fetch for every `hyperbolic-core` zone. It is a private workspace package.

## 📋 Product Boundaries

- `src/types.ts` is a frozen interface mandated by ADR-03 (`docs/planning/04-adrs.md`). Changing it is a contract change, not a refactor.
- `src/registry.ts` holds one of the six hardcoded copies of the platform publishable key. The key is public by design — RLS is the authorization boundary — but rotating it means editing all six copies. See the repo-root `AGENTS.md`.
- This package is the natural single owner if those six copies are ever consolidated. Consolidation is not free; the root `AGENTS.md` records why.
- Make the smallest clear change that completely resolves its linked GitHub Issue.
- Preserve behavior-focused tests; never weaken assertions to make a gate pass.

## ⚙️ Commands

```bash
npm test          # node --test tests/
npm run typecheck # tsc -b . && tsc -p tsconfig.test.json
```

## ✅ Completion Criteria

GitHub Issues are the durable work source. A change is ready when its linked Issue's acceptance criteria are satisfied, the commands above pass, and the root's `.github/workflows/shell-ci.yml` terminal check `Shell PR Gate` succeeds — it covers `packages/**`.

## 🔒 Collaboration Boundary

AI coding agents may create assigned branches, commits, Issues, and pull requests. They must not submit reviews, approve or block pull requests, request reviewers, or post unsolicited comments. They may answer in an Issue or pull request only when explicitly tagged with a direct question.
