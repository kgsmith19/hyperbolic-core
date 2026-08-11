# Agentic Command Center

Agentic Command Center (ACC) is a local guard rail, control panel, and bounded
task runner for Claude Code sessions. Keep changes lean, preserve product
safety, and verify the behavior you change.

## Product map

- `hooks/guard.mjs` is the `PreToolUse` guard. It fails closed when its input
  or configuration cannot be read.
- `hooks/engine.mjs` owns guard, vault, watched-project, and runbox mutations.
- `gui/server.mjs` serves the loopback web interface. `gui/README.md` is its
  API contract.
- `ui/` is the React front end served through `gui/server.mjs --ui-dist`.
  `ui/e2e/contract.spec.ts` verifies it against the real sandboxed server.
- `kernel/` runs bounded headless tasks and records their results. Read
  `kernel/README.md` before changing the kernel contract or adapters.
- `runner/` owns directive execution and lifecycle state. Read
  `runner/README.md` before changing the directive loop.
- `hooks/lane.mjs` serializes automated Claude launches. Every automated
  launch must use the lane.
- `policy.json` is product runtime configuration. Preserve unowned keys when
  updating part of it.

Product architecture decisions remain in `docs/adr/`. Completed and
historical implementation specifications are context, not current workflow
requirements. GitHub Issues define new work.

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
- Preserve the machine-wide launch-lane constraint in `hooks/lane.mjs`.
- Do not weaken or delete a regression test unless the behavior it protects
  has intentionally been removed and the change explains why.

## Commands

```bash
npm install
npm test
npm run covgate
npm run test:windows
npm run e2e:gui
npm run gui
cd ui && npm ci
cd ui && npm run build
cd ui && ACC_DIR=.. npm run e2e
```

The Windows suite also exercises:

```powershell
powershell -File shim/claude.test.ps1
powershell -File watcher/claude-cap-watch.test.ps1
powershell -File watcher/install-cap-watch-task.test.ps1
```

Real-token proof commands are intentionally manual. Read the relevant
subsystem documentation before running them.

## Delivery workflow

1. Start from a GitHub Issue with a concrete outcome and acceptance criteria.
2. Implement the smallest coherent change.
3. Add or update focused tests and run the relevant commands above. Changes
   spanning the API and React client must keep `gui/README.md`, `ui/src/api.ts`,
   and the UI contract suite consistent.
4. Open a pull request that links the Issue and reports exact verification.
5. Let `.github/workflows/ci.yml` produce the single required check,
   `PR Gate`.
6. After the configured gate passes, GitHub may squash-merge the pull request
   and delete the branch.

The reference in `.agent/standard.lock` is informational and non-enforcing.
Repository code, product documentation, tests, and the local `PR Gate` remain
the sources for implementation decisions.

## Collaboration boundary

When explicitly assigned, an AI coding agent may create an Issue, branch,
commit, or pull request and may answer a direct question after an explicit
mention. An AI agent must not submit a review, approve or request reviewers,
block CI/CD, or post unsolicited Issue or pull-request comments.

Preserve unrelated work, do not widen scope silently, and state any validation
that could not be completed.
