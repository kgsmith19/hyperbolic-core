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
| [`apps/agentic-command-center`](apps/agentic-command-center) | Local coding-agent guard rail, control panel, and bounded task runner | `Verify: ACC` |
| [`apps/lifeos`](apps/lifeos) | Personal life-management system — typed entity graph, append-only event log | `Verify: LifeOS` |
| [`apps/shell`](apps/shell) | Unified React/Vite front end composing every zone behind one owner login | `Verify: Shell` |
| [`apps/toolbelt`](apps/toolbelt) | Small portfolio tools — a prompt-library client, local-first network diagnostics | `Verify: Toolbelt` |
| [`services/brain`](services/brain) | Long-lived autonomous-coding orchestrator — daemon, DAG scheduler, task/result contracts | `Verify: Brain` |
| [`services/llm-handler`](services/llm-handler) | Deployed general-purpose LLM service behind the Shell | covered by `Verify: Shell` |
| [`packages/*`](packages) | Shared TypeScript packages — `platform-client`, `ui`, `llm`, `toolbelt-cli` | covered by each consumer |

Every `apps/<name>/` was imported via `git subtree` and still carries its own upstream
`README.md`/`AGENTS.md` — read those before working inside an app. `services/` and `packages/`
are native to this repo.

> ⚠️ **`apps/lifeos`'s own nested `.github/workflows/`** ship real production deploy, backup, and
> ops automation and are **intentionally inert here** — GitHub only ever runs workflows from a
> repository's root, and these must never be copied there. Full rationale in
> [`AGENTS.md`](./AGENTS.md)'s Workflow Safety Invariant section.

## 🚦 CI & merge gates

`.github/workflows/pr-verify.yml` runs every `Verify: *` gate on every pull request, but keeps
the *required* surface small: `Verify: Secrets` → `Verify: Repo Policy` → `Verify: PR Description`
→ `Verify: Linting` (LifeOS's own lint commands — the only app with one configured today) run in
strict sequence first, then the five app gates from the table above run in parallel, then
`Verify: Tests` — a single umbrella check, not five separate required ones — passes only once all
five have. `Verify: LLM Review` runs last and stays non-required until reviewer credentials are
provisioned. See [`AGENTS.md`](./AGENTS.md)'s "PR Gate and merge behavior" section for the full
order, which gates are (intended to be) required by the branch ruleset, and what's actually
enforced right now versus the intended target — and [`project.yaml`](./project.yaml) for the full
topology.

## 📜 Policy

This repository follows the [Agent Engineering
Standard](https://github.com/kgsmith19/agent-engineering-standard), pinned to an exact commit in
[`standard.lock`](./standard.lock). [`AGENTS.md`](./AGENTS.md) is the source of truth for agent
and engineering rules; [`project.yaml`](./project.yaml) for exact repository facts and commands.

## 📄 License

[MIT](./LICENSE)
