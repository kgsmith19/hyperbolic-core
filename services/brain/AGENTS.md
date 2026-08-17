# AGENTS.md

## 🎯 Purpose

`services/brain` is the Brain daemon: a long-lived autonomous-coding
orchestrator (07-brain-architecture.md). It owns run/task state (SQLite
WAL), schedules a task DAG under an N=2 concurrency cap, dispatches tasks
to harness adapters in per-task git worktrees, enforces autonomy/approval
policy, and exposes both a `brain` CLI and an authenticated HTTP API. It
is a real deployable container with its own isolated Anthropic key --
distinct from the small shared packages under `packages/`, and from
`services/llm-handler`, which it never calls (it links `@hyperbolic/llm`
in-process instead, per 08's forced decision 5).

## 📋 Product Boundaries / Invariants

- ADR-05 key isolation: the Brain's own Anthropic key is rendered once,
  at deploy time, to a file only the `brain` container/OS user can read
  (`BRAIN_SECRET_FILE`), never a plain env var. It cannot read
  `/platform/llm/` or any other unit's secrets, and no other unit's
  container ever has this file mounted. `scripts/isolation-check.mjs`
  enforces the observable half of this in CI on every PR.
- Names-only credential design (07 section 7.10): vault key *names* flow
  through `TaskContractV1.constraints.vault_keys` and
  `kernel-contract.ts`'s `allowedActions.vaultKeys`; no vault key *value*
  is structurally reachable inside the Brain process. The scrubber
  (`src/scrubber.ts`) is belt-and-suspenders on top of that design, not a
  substitute for it -- it masks accidental token-shaped strings in logs
  and prompt assembly, including the Brain's own Anthropic key.
- Autonomy levels A0-A3 (`src/autonomy.ts`): A0 dispatches zero harness
  invocations ever; A1 dispatches only tasks with no write deliverable;
  A2 (default) is full execution; A3 adds multi-task auto-chaining. The
  always-approve list (repo allowlist, per-run cost ceiling) applies
  regardless of level and is re-checked on every re-pending transition,
  not just once.
- One git worktree per task, namespaced by `task_id`, created before
  dispatch and removed after result persistence (`src/worktree.ts`).
  Concurrent same-repo worktree creation is serialized through a
  directory lock around the bare-mirror clone/fetch step only; `git
  worktree add` itself is safe to run concurrently.
- Crash recovery (`src/daemon.ts`): on boot, any task found `running` is
  probed and either re-attached, resumed, or marked `interrupted`
  (resumable) -- never silently left in an inconsistent state. SIGTERM
  drains running harness children with a grace period before exit.
  Journal writes are flushed per event; at most the current in-flight
  stream deltas since the last flush are lost on crash.
  `brain.eval-case.v1`'s `expected.status` has no "awaiting approval"
  value -- approval-gating only runs inside the scheduler, not in
  `runEvalCase`'s direct-dispatch path, so it cannot be represented
  literally in the eval corpus (see `evals/cases/README.md`).
- Every `/api/brain/*` route (except `/healthz` and `/api/brain/health`)
  goes through `requireAuth` (ADR-03: owner-session JWT or a scoped
  agent-token JWT) before reaching its handler, and a malformed/absent
  credential must reject within the route's own latency budget without a
  network round trip.
- `/healthz` (bare) and `/api/brain/health` (prefixed) must both keep
  working and stay unauthenticated, for the same loopback-healthcheck vs.
  tailscale-path-mounting reasons as `services/llm-handler`.
- Every S1/S2 Brain failure must produce a new case in `evals/cases/`
  before its fix merges (07 section 7.11).

## 📂 Layout

```
bin/brain.mjs           CLI entrypoint: argv parsing/dispatch only
src/index.ts             daemon entrypoint
src/server.ts             HTTP surface: /healthz, /api/brain/*
src/daemon.ts             startup/shutdown/crash-recovery lifecycle
src/scheduler.ts          DAG scheduler, N=2 concurrency cap
src/dispatch.ts           worktree + harness dispatch + result mapping
src/adapters/             harness adapters (claude-code, stub, fixture)
src/router.ts             initial/fallback adapter selection
src/autonomy.ts            A0-A3 autonomy levels, always-approve rules
src/approval-gate.ts       scheduler-facing approval decision + parking
src/contracts.ts           brain.task.v1/brain.result.v1 ajv validation
src/schemas/               JSON Schema files contracts.ts validates against
src/journal.ts             per-run append-only ndjson event journal
src/scrubber.ts            log/prompt secret-shaped-string masking
src/worktree.ts            per-task git worktree lifecycle
src/cli/                   CLI verb logic (pure, store/journal/config-only)
src/evals.ts                eval-case loading/running/capture
evals/cases/                the eval corpus
scripts/isolation-check.mjs ADR-05 secret-isolation check
tests/                      node --test suite
```

## ⚙️ Commands

```bash
npm run test --workspace=@hyperbolic/brain
npm run typecheck --workspace=@hyperbolic/brain
node src/index.ts
node bin/brain.mjs <verb> [--json]
node bin/brain.mjs eval run --json
node scripts/isolation-check.mjs
docker build -f services/brain/Dockerfile .   # context is the monorepo root
```

## 📚 Documentation

`docs/ops/runbook.md`'s "Brain deployment" section covers the deploy
pipeline, required Infisical secrets (`/brain/`), manual rollback, and a
documented known gap in `/brain/stream` external tailscale routing.

## ✅ Completion

A change is ready when its acceptance criteria are satisfied, affected
documentation is accurate, the commands above pass locally, and the
`Verify: Tests (Linux)` reports success --
that gate also runs the eval corpus and the isolation check, and builds
and smoke-runs the Docker image. State any unverified item explicitly.

## 🔒 Collaboration Boundary

When explicitly assigned, an AI coding agent may create an Issue, branch,
commit, or pull request, and may answer a direct question after an explicit
mention. An AI agent must not submit a review, approve or request reviewers,
block CI/CD, or post unsolicited Issue or pull-request comments.

Preserve unrelated work, do not widen scope silently, and state any validation
that could not be completed.
