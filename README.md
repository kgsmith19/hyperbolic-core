# hyperbolic-core

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Gitleaks](https://github.com/kgsmith19/hyperbolic-core/actions/workflows/secret-scan.yml/badge.svg)](https://github.com/kgsmith19/hyperbolic-core/actions/workflows/secret-scan.yml)
[![Agent Engineering Standard](https://img.shields.io/badge/standard-Agent%20Engineering%20Standard-6f42c1)](https://github.com/kgsmith19/agent-engineering-standard)

A monorepo of agentic tools, apps, and the platform behind them — a local coding-agent guard
rail, a life-management system, a portfolio toolbelt, and the shared services and UI that tie
them together. Built and operated under the [Agent Engineering
Standard](https://github.com/kgsmith19/agent-engineering-standard).

## 📦 What's inside

| Component | What it is | Gate |
| --- | --- | --- |
| [`apps/agentic-command-center`](apps/agentic-command-center) | Local coding-agent guard rail, control panel, and bounded task runner | `ACC Linux` + `ACC Windows` |
| [`apps/lifeos`](apps/lifeos) | Personal life-management system — typed entity graph, append-only event log | `LifeOS` (its lint runs as a step there too) |
| [`apps/shell`](apps/shell) | Unified React/Vite front end composing every zone behind one owner login | `Platform` |
| [`apps/toolbelt`](apps/toolbelt) | Small portfolio tools — a prompt-library client, local-first network diagnostics | `Toolbelt` |
| [`services/brain`](services/brain) | Long-lived autonomous-coding orchestrator — daemon, DAG scheduler, task/result contracts | `Brain` |
| [`services/llm-handler`](services/llm-handler) | Deployed general-purpose LLM service behind the Shell | covered by `Platform` |
| [`packages/*`](packages) | Shared TypeScript packages — `platform-client`, `ui`, `llm`, `review`, `toolbelt-cli` | covered by `Platform` (and `Toolbelt` for `toolbelt-cli`) |

Every `apps/<name>/` was imported via `git subtree` and still carries its own upstream
`README.md`/`AGENTS.md` — read those before working inside an app. `services/` and `packages/`
are native to this repo.

> ⚠️ **`apps/lifeos`'s own nested `.github/workflows/`** ship real production deploy, backup, and
> ops automation and are **intentionally inert here** — GitHub only ever runs workflows from a
> repository's root, and these must never be copied there. Full rationale in
> [`AGENTS.md`](./AGENTS.md)'s Workflow Safety Invariant section.

## 🚦 CI & merge gates

`.github/workflows/pr-verify.yml` is the **only** workflow that runs on a pull request, and it
handles both verification and merge orchestration. Each job is a native job producing exactly one
check row under its own bare name — **nine rows, one required**. Repository Standards verifies the
repository, each app lane verifies itself, AI Review independently evaluates the change, and PR
Gate verifies that every lane succeeded and alone controls merge authorization:

| Row | What it does | Required |
| --- | --- | --- |
| `Repository Standards` | leaked-credential scan, repo structure, PR description, exact-head consistency — repository integrity only | No |
| `Toolbelt` / `ACC Linux` / `ACC Windows` / `Brain` / `Platform` / `LifeOS` | each app's complete, self-contained engineering verification, fully parallel | No |
| `AI Review` | adversarial LLM review of the diff — `needs:` Repository Standards only | No |
| `PR Gate` | rollup verdict **and** merge orchestration | **Yes** |

One check row per job is a GitHub invariant with no suppression, but by owner directive this repo
optimizes for clear ownership, parallel execution, and diagnostics over the fewest rows: the seven
worker lanes above the rollup all start together at T=0. **Every lane still reports in seconds when
its app wasn't touched** — it exists and runs on every PR, using the shared `detect-changes` action
inside the job (never a `paths:` filter) to report an explicit "not applicable" instead of the job
disappearing, which is what keeps the required check reporting on every PR.

`PR Gate` reads its verdict from the workflow's own `needs.*.result` — anything that isn't exactly
`success` (including `skipped`) fails it — and it is the only name in the branch ruleset. `AI
Review` is a `needs:` dependency of `PR Gate` by owner decision, so it is mandatory in substance
even though it isn't separately listed in the ruleset. `PR Gate` also arms native squash auto-merge
and maintains the Work State comment, as the last step of the same job that computes the verdict,
so a merge can't be enabled ahead of the verification it depends on. There's no separate
merge-policy workflow; that logic lives entirely in `PR Gate`.

See [`AGENTS.md`](./AGENTS.md)'s "PR Gate and merge behavior" section for the full order, which
gates are (intended to be) required by the branch ruleset, and what's actually enforced right now
versus the intended target — and [`project.yaml`](./project.yaml) for the full topology.

## 📜 Policy

This repository follows the [Agent Engineering
Standard](https://github.com/kgsmith19/agent-engineering-standard), pinned to an exact commit in
[`standard.lock`](./standard.lock). [`AGENTS.md`](./AGENTS.md) is the source of truth for agent
and engineering rules; [`project.yaml`](./project.yaml) for exact repository facts and commands.

## 📄 License

[MIT](./LICENSE)

<!-- diagnostic-only PR: verifying the review-gate Infisical OIDC identity against a real
     pull_request-triggered token; safe to close without merging -->
