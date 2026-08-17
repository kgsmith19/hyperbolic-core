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
| [`apps/agentic-command-center`](apps/agentic-command-center) | Local coding-agent guard rail, control panel, and bounded task runner | `Verify: Tests (ACC)` + `Verify: Tests (ACC Windows)` |
| [`apps/lifeos`](apps/lifeos) | Personal life-management system — typed entity graph, append-only event log | `Verify: Tests (LifeOS)` (lint runs as a step inside `Verify: Standards`) |
| [`apps/shell`](apps/shell) | Unified React/Vite front end composing every zone behind one owner login | `Verify: Tests (Shell)` |
| [`apps/toolbelt`](apps/toolbelt) | Small portfolio tools — a prompt-library client, local-first network diagnostics | `Verify: Tests (Toolbelt)` |
| [`services/brain`](services/brain) | Long-lived autonomous-coding orchestrator — daemon, DAG scheduler, task/result contracts | `Verify: Tests (Brain)` |
| [`services/llm-handler`](services/llm-handler) | Deployed general-purpose LLM service behind the Shell | covered by `Verify: Tests (Shell)` |
| [`packages/*`](packages) | Shared TypeScript packages — `platform-client`, `ui`, `llm`, `toolbelt-cli` | covered by each consumer |

Every `apps/<name>/` was imported via `git subtree` and still carries its own upstream
`README.md`/`AGENTS.md` — read those before working inside an app. `services/` and `packages/`
are native to this repo.

> ⚠️ **`apps/lifeos`'s own nested `.github/workflows/`** ship real production deploy, backup, and
> ops automation and are **intentionally inert here** — GitHub only ever runs workflows from a
> repository's root, and these must never be copied there. Full rationale in
> [`AGENTS.md`](./AGENTS.md)'s Workflow Safety Invariant section.

## 🚦 CI & merge gates

`.github/workflows/pr-verify.yml` runs every gate on every pull request. Each one is a native job
named `Verify: <what>`, producing exactly one check row under that bare name — nine rows there,
plus one more (`Verify: Merge Policy`) from the separate `merge-policy.yml`.

`Verify: Standards` runs first: one job carrying every repo-wide conformance check (which apps
changed, leaked-credential scan, repo structure, PR description, lint). Then the six
`Verify: Tests (<App>)` gates run in parallel, then a `Verify: All Gates` rollup job, then
`Verify: LLM Review` last.

**Every test gate always runs and always reports** — when its app wasn't touched it reports a
trivial pass in seconds instead of running the suite, using `Verify: Standards`'s job outputs
rather than a `paths:` filter. `Verify: All Gates` needs all seven of those jobs and fails if any
of them is anything but a fresh success (`if: always()`, so it still reports even when one of them
failed). **It's the only one of the nine actually required by the branch ruleset** — one name to
type instead of seven, which is deliberately how it stays in sync with what this file says: seven
required-in-substance checks drifting out of sync with a required-checks list typed by hand is
what stranded PRs #118, #120, and #160 before. `Verify: LLM Review` (no reviewer credentials yet)
and `Verify: Merge Policy` (orchestration, not verification — it's what arms auto-merge, and its
own workflow is named `Merge Automation` precisely so its row doesn't read as a duplicate of
itself in the checks list) are deliberately *not* required.

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
