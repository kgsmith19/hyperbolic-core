# Agentic Command Center

Agentic Command Center (ACC) is an adapter-driven local coding-agent service,
guard rail, control panel, and bounded task runner. Claude Code is the current
harness integration; generic kernel code must remain harness-neutral.

## Product map

- The `PreToolUse` guard and its config mutations (enable/disable, secret
  globs, protected paths) live in `apps/toolbelt/guards` — a standalone
  module this repo does not import. The guard fails closed when its input or
  configuration cannot be read.
- `backend/hooks/engine.mjs` owns the vault and runbox (watched-project) mutations.
  `backend/gui/server.mjs` shells both it and `apps/toolbelt/guards/cli.mjs` for
  every guards-related route, composing them where the browser-facing API
  still expects one shape (`GET /api/guards/status`).
- `backend/gui/server.mjs` serves the loopback web interface. `backend/gui/README.md` is its
  API contract.
- `frontend/` is the React front end served through `backend/gui/server.mjs --ui-dist`.
  `frontend/src/api.ts` is the typed client mirroring `backend/gui/README.md`, and
  `frontend/e2e/contract.spec.ts` verifies it against the real sandboxed server.
  Contract drift is a product defect: change the server contract, the client
  types, and the contract test together. `frontend/` is a standalone npm
  project, not a workspace member, so it installs and builds on its own.
- Generated output (`frontend/dist/`, Playwright reports, test results) is
  read-only. Change a source file and regenerate.
- `frontend/src/components/ui/` holds seven primitives — badge, button, card,
  input, label, radio-group, textarea — that all also exist in `packages/ui/src/
  primitives/`, the package created to own exactly these. **They have already
  drifted**, 8–24 differing lines each, and not only cosmetically: this app's
  badge renders `rounded-4xl` where the package renders `rounded-full`, and the
  two use different design-token vocabularies entirely (here `bg-primary` /
  `text-primary-foreground` / `destructive`; the package `bg-accent` /
  `text-accent-fg` / `danger`). This frontend defines its own tokens in
  `src/index.css` and never loads `packages/ui/styles/tokens.css`, so it is not
  on the platform design system at all. Adopting the package is not a lean edit:
  `frontend/` is deliberately a standalone npm project rather than a workspace
  member (see the bullet above), so consuming `@hyperbolic/ui` is a build- and
  dependency-graph change with its own contract-suite consequences. Do not fix
  it incidentally, and do not "improve" a primitive here without knowing you are
  editing the copy that the Shell does not use.
- `backend/kernel/` runs bounded headless tasks and records their results. Read
  `backend/kernel/README.md` before changing the kernel contract or adapters.
- `backend/runner/` owns directive execution and lifecycle state. Read
  `backend/runner/README.md` before changing the directive loop.
- `backend/hooks/lane.mjs` serializes automated harness launches. Every automated
  launch must use the lane.
- `policy.json` is product runtime configuration. Preserve unowned keys when
  updating part of it.

GitHub Issues define new work. This repository does not keep committed ADRs
or SPEC documents — architectural rationale that matters operationally lives
in the code and docs it governs (e.g. `backend/gui/README.md`), not in a separate
decision record; historical rationale otherwise lives in git history.

## Safety boundaries

- Never place a secret value in a commit, command argument, log, response, or
  conversation. The vault is consumed by key name; vault imports use stdin.
- Never read a target environment file after applying vault values to it.
- The browser must clear secret inputs after save and must not persist them.
- Browser input may select only explicitly allowlisted server actions; it
  must never become arbitrary command arguments.
- Runbox scripts are human-triggered. Do not restore unattended execution.
  Make each script self-contained, minimal, idempotent, and explicit about
  side effects. Never print secrets and never run `flush` as an agent.
- Tests that touch state must use temporary `ACC_ROOT`, `ACC_POLICY`, and,
  where applicable, `ACC_LANE_DIR` paths. Do not run hooks manually against
  live state.
- Preserve the machine-wide launch-lane constraint in `backend/hooks/lane.mjs`.
- Do not weaken or delete a regression test unless the behavior it protects
  has intentionally been removed and the change explains why.

### `backend/gui/server.mjs`'s `handler` — how far the refactor can go

`handler` is the most complex function in this repository by a wide margin
(143 decision points; the next highest anywhere is 68): a security preamble —
Host, then Origin, preflight, CORS, the `X-ACC` header, then the token —
followed by 14 `route === "/api/..."` branches and 17 method checks.

The security preamble is now its own `enforceRequestSecurity`, so "these run
ONCE and a future route cannot forget them" is structural rather than a matter
of where someone pastes the next `if`. That cost 23 lines rather than saving
any, and it was kept because the property is worth more than the lines; it was
verified by measurement, not argued -- 614/614 ACC tests and covgate at 98.4%
lines / 88.9% branches, both slightly ABOVE the pre-change 98.3 / 88.8.

A route table for the remaining 14 `route === "..."` branches is a different
matter, and the blocker is a coverage floor. `policy.json` floors this file at
98% lines / 88.5% branches, and names precisely which branches are uncovered:
Windows-only ACL application, POSIX ownership-mismatch defenses no unprivileged
portable test can reach, and the losing sides of an exclusive token-file race.
A route table removes *covered* dispatch branches while every *uncovered*
branch stays, so branch coverage moves toward that untestable remainder.

**The margin is not what it was, and the old estimate is stale.** That
analysis was run against a measured 98.32 lines / 88.79 branches and put a
route table at 87.3–88.0%, below the floor on every assumption. The file now
measures **98.6 lines / 89.3 branches** — folding out a duplicated `pidAlive`
raised both. Re-derive the estimate before concluding anything; do not reuse
the 87.3–88.0 figure, which was computed from a baseline half a point lower.

A general caution learned the hard way while measuring that change: **the
direction a deletion moves branch coverage is not predictable from a file's
current percentage.** The same kind of edit raised this file and *lowered*
`hooks/budget.mjs` (75.5 → 75.3) and `runner/runner.mjs` (90.3 → 90.1), both
of which now sit within a third of a point of their floors. Run covgate per
change; do not reason about it.

Whatever the re-derived number says, do not lower a security boundary's
coverage floor to buy readability, and do not take this on incidentally. If it
is taken on, it is its own change with the coverage question settled first.

## Commands

```bash
npm install
npm test
npm run covgate
npm run test:windows
npm run gui
cd frontend && npm ci
cd frontend && npm run build
cd frontend && ACC_DIR=.. npm run e2e
```

The Windows suite also exercises:

```powershell
powershell -File backend/shim/claude.test.ps1
powershell -File backend/watcher/claude-cap-watch.test.ps1
powershell -File backend/watcher/install-cap-watch-task.test.ps1
```

Real-token proof commands are intentionally manual. Read the relevant
subsystem documentation before running them.

## Delivery workflow

1. Start from a GitHub Issue with a concrete outcome and acceptance criteria.
2. Implement the smallest coherent change.
3. Add or update focused tests and run the relevant commands above. Changes
   spanning the API and React client must keep `backend/gui/README.md`, `frontend/src/api.ts`,
   and the UI contract suite consistent.
4. Open a pull request that links the Issue and reports exact verification.
5. Let `.github/workflows/acc-ci.yml` produce this app's required check,
   `ACC PR Gate`.
6. After the configured gate passes, GitHub may squash-merge the pull request
   and delete the branch.

The reference in the root `standard.lock` is informational and non-enforcing.
Repository code, product documentation, tests, and the local `PR Gate` remain
the sources for implementation decisions.

## Collaboration boundary

When explicitly assigned, an AI coding agent may create an Issue, branch,
commit, or pull request and may answer a direct question after an explicit
mention. An AI agent must not submit a review, approve or request reviewers,
block CI/CD, or post unsolicited Issue or pull-request comments.

Preserve unrelated work, do not widen scope silently, and state any validation
that could not be completed.
