# Agentic Command Center UI

This directory is the React front end for ACC. The monorepo server serves the
built `dist/` directory same-origin through `--ui-dist`.

## Product contract

- ACC's `gui/README.md` is the API contract.
- `src/api.ts` is the typed client that mirrors that contract.
- `e2e/contract.spec.ts` verifies the UI against a real, sandboxed ACC server.
- Contract drift is a product defect. Update the server contract, client
  types, and contract test together when an intentional interface change
  spans both repositories.
- Treat generated output such as `dist/`, Playwright reports, and test results
  as read-only. Change source files and regenerate the output.
- Vault values may pass through the browser only long enough to submit them.
  Never log or persist them on the client.

## Commands

```bash
npm ci
npm run build
ACC_DIR=.. npm run e2e
npm run dev
```

The development server proxies `/api` to ACC. Set `ACC_API` only when a
different local target is intentional. The root `PR Gate` runs this directory's
build and contract suite against the monorepo ACC server.

## Delivery workflow

1. Start from a GitHub Issue with a concrete outcome and acceptance criteria.
2. Implement the smallest coherent change.
3. Run `npm run build` and the ACC contract suite.
4. Open one repository pull request that links the Issue and reports exact
   verification.
5. Let the root `.github/workflows/ci.yml` produce the single required check,
   `PR Gate`.
6. After the configured gate passes, GitHub may squash-merge the pull request
   and delete the branch.

The root `.agent/standard.lock` is informational and non-enforcing. Repository
code, the ACC API contract, tests, and the root `PR Gate` remain the sources
for implementation decisions.

## Collaboration boundary

When explicitly assigned, an AI coding agent may create an Issue, branch,
commit, or pull request and may answer a direct question after an explicit
mention. An AI agent must not submit a review, approve or request reviewers,
block CI/CD, or post unsolicited Issue or pull-request comments.

Preserve unrelated work, do not widen scope silently, and state any validation
that could not be completed.
