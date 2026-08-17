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
| [`apps/agentic-command-center`](apps/agentic-command-center) | Local coding-agent guard rail, control panel, and bounded task runner | `Verify: Tests (Linux)` + `Verify: Tests (Windows)` |
| [`apps/lifeos`](apps/lifeos) | Personal life-management system — typed entity graph, append-only event log | `Verify: Tests (Linux)` (its lint runs as a step there too) |
| [`apps/shell`](apps/shell) | Unified React/Vite front end composing every zone behind one owner login | `Verify: Tests (Linux)` |
| [`apps/toolbelt`](apps/toolbelt) | Small portfolio tools — a prompt-library client, local-first network diagnostics | `Verify: Tests (Linux)` |
| [`services/brain`](services/brain) | Long-lived autonomous-coding orchestrator — daemon, DAG scheduler, task/result contracts | `Verify: Tests (Linux)` |
| [`services/llm-handler`](services/llm-handler) | Deployed general-purpose LLM service behind the Shell | covered by `Verify: Tests (Linux)` |
| [`packages/*`](packages) | Shared TypeScript packages — `platform-client`, `ui`, `llm`, `toolbelt-cli` | covered by each consumer |

Every `apps/<name>/` was imported via `git subtree` and still carries its own upstream
`README.md`/`AGENTS.md` — read those before working inside an app. `services/` and `packages/`
are native to this repo.

> ⚠️ **`apps/lifeos`'s own nested `.github/workflows/`** ship real production deploy, backup, and
> ops automation and are **intentionally inert here** — GitHub only ever runs workflows from a
> repository's root, and these must never be copied there. Full rationale in
> [`AGENTS.md`](./AGENTS.md)'s Workflow Safety Invariant section.

## 🚦 CI & merge gates

`.github/workflows/pr-verify.yml` is the **only** workflow that runs on a pull request, and it
handles both verification and merge orchestration. Each job is a native job named
`Verify: <what>`, producing exactly one check row under that bare name — **four rows, one
required**:

| Row | What it does | Required |
| --- | --- | --- |
| `Verify: Tests (Linux)` | every repo-wide conformance check (changed apps, leaked-credential scan, repo structure, PR description, lint) then the Toolbelt, ACC, Brain, Shell and LifeOS suites | No |
| `Verify: Tests (Windows)` | ACC's PowerShell/native suites — a separate row because one job runs on one runner image | No |
| `Verify: LLM Review` | adversarial LLM review of the diff | No — no reviewer credentials yet |
| `Verify: All Gates` | rollup verdict **and** merge orchestration | **Yes** |

One check row per job is a GitHub invariant with no suppression, so the only way to shorten the
list is to run fewer jobs — hence one big Linux job. That roughly doubles wall-clock (measured 8.0
min parallel vs 17.3 min summed, on a PR where every suite ran for real) in exchange for four rows
instead of ten. **Every suite still skips in seconds when its app wasn't touched**, using the
shared `detect-changes` action rather than a `paths:` filter, which is what keeps the required
check reporting on every PR.

`Verify: All Gates` reads its verdict from the workflow's own `needs.*.result` — anything that
isn't exactly `success` (including `skipped`) fails it — and it is the only name in the branch
ruleset. It also arms native squash auto-merge and maintains the Work State comments, as the last
step of the same job that computes the verdict, so a merge can't be enabled ahead of the
verification it depends on. (There's no separate merge-policy workflow any more; it was absorbed
here.)

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
