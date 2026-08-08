# AGENTS.md

Operational map for agents working in this repo. This is a map, not an
encyclopedia — details live at their canonical source, linked below.

## Standard

This repo follows `kgsmith19/agent-engineering-standard`, pinned at the
commit in `.agent/standard.lock`. Bumping that pin is its own explicit PR
(re-read the standard, re-apply what changed) — never silent drift onto a
moving branch.

## Product truth

- This repo is the UI half of ADR-0006 in `kgsmith19/agentic-command-center`
  (ACC): a React front end that ACC serves same-origin via `--ui-dist`.
- Requirements live in ACC's `docs/PRD.md` (FR-010, FR-012) and
  `docs/adr/ADR-0006-*.md`. This repo has no separate PRD — don't fork one;
  update ACC's if product intent changes.
- **The API contract is ACC's `gui/README.md`.** `src/api.ts` mirrors it in
  types; `e2e/contract.spec.ts` proves it against a real ACC server. Drift
  between them is a bug to fix, not a spec question to debate.
- Stack, layout, and house rules: see `README.md`.

## Commands (tested from a clean checkout)

| Purpose | Command |
|---|---|
| Setup | `npm ci` |
| Fast verify (every slice, before pushing) | `npm run build` |
| Full verify (the real acceptance evidence) | `ACC_DIR=<path-to-acc-checkout> npm run e2e` |
| Dev server | `npm run dev` (proxies `/api`; override target with `ACC_API=`) |

`full_verify` needs a sibling checkout of `kgsmith19/agentic-command-center`
— CI clones one fresh (`.github/workflows/ci.yml`); locally, clone it next to
this repo or pass `ACC_DIR`.

## Work tracking

GitHub Issues are the durable work-item system — no separate backlog or TODO
file. New work items use `.github/ISSUE_TEMPLATE/work-item.md`. Labels:
`status:ready`, `status:blocked`, `risk:R0`–`risk:R4`. A code `TODO` comment
may note a local implementation detail, but durable work belongs in an Issue.

## Execution model

- One thin slice at a time, short-lived branch (worktree when practical).
- Evidence before implementation: define acceptance criteria and the
  strongest cheap oracle, get a meaningful RED, then minimum GREEN. Refactor
  only after GREEN.
- This repo's whole test surface is `e2e/contract.spec.ts` — an acceptance
  suite against a real ACC server, not a unit-test pyramid. Most behavior
  changes should extend that suite rather than invent a new evidence layer;
  add unit tests only for pure logic with real edge cases (there isn't much).
- Never weaken, skip, or delete evidence to get GREEN. If a check looks
  wrong, report the conflict — don't route around it.

## Risk & authority

- Scale: `R0` (trivial/non-behavioral) through `R4` (destructive/
  irreversible). See `.agent/project.yaml` for this repo's per-path notes.
  In practice this repo's ceiling is `R2` — it holds no secrets, no
  server-side state, and talks only to ACC's loopback API. Vault values pass
  through the browser only long enough to POST them; never logged, never
  persisted client-side.
- An agent may raise its own declared risk, never lower it or bypass a check
  gating its own run.
- `.github/workflows/ci.yml` is the protected evaluator. Don't change its
  required checks, thresholds, or the branch ruleset in the same PR as the
  behavior change it's supposed to be gating.

## Before calling anything done

Clean-checkout `npm run build` and `npm run e2e` both green — not "the code
looks right." State exactly what you could not verify.
