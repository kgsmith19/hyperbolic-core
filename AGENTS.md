# Agent Engineering Standard — hyperbolic-core

Operational rules for humans and AI agents working in this repository. This repository adopts
the [Agent Engineering Standard](https://github.com/kgsmith19/agent-engineering-standard),
pinned to an exact commit in `standard.lock`, with the repository-specific adaptations recorded
below. Where this document is silent, the pinned standard's own `AGENTS.md` governs in spirit;
this file is the authoritative, repo-accurate text for `hyperbolic-core` itself.

## Objective

Deliver small, verified, independently mergeable changes with honest evidence, under absolute
owner authority, using GitHub Issues, Milestones, pull requests, and this repository's six
path-scoped PR Gates as the machinery of record.

## 🎯 Repository purpose

`hyperbolic-core` is a monorepo consolidating multiple standalone repos under `apps/<name>/`.
Each app was imported via `git subtree` and retains its own upstream `AGENTS.md`, `CLAUDE.md`,
and docs, which describe that app as it looked as a standalone repo. Read the nested `AGENTS.md`
under an app's directory for that app's actual rules before working in it. `services/brain` and
`services/llm-handler`, and the shared `packages/*`, are native to this repo (not subtree
imports) and have no separate upstream docs.

## ⚠️ Workflow Safety Invariant

The repo-root `.github/workflows/` contains only workflows deliberately activated for
`hyperbolic-core` itself. Files under any `apps/*/.github/workflows/` are inert by design —
GitHub only executes workflows from a repository's root `.github/workflows/`, never from a
nested path — and they must never be copied or moved to the root.

> [!WARNING]
> This matters concretely, not just abstractly. `apps/lifeos/.github/workflows/ci.yml` contains
> a `build-backend` job that, unlike its sibling deploy jobs, has no repository-variable gate on
> it. If that workflow were ever relocated to the root, `build-backend` would run for real on
> every push to `main` and publish a Docker image to `ghcr.io/kgsmith19/hyperbolic-core`. That is
> the kind of accident this rule exists to prevent.

## ⚠️ The platform publishable key has six hardcoded copies

The same Supabase publishable (anon) key literal is hardcoded in six files across five trees:

```
apps/lifeos/frontend/src/lib/session.ts
apps/shell/frontend/src/lib/session.ts
apps/toolbelt/apps/prompt-organizer/frontend/index.html
apps/toolbelt/tests/helpers.mjs
packages/llm/src/prompt-client.ts
packages/platform-client/src/registry.ts
```

This is **not** a leaked secret — a publishable key is public by design, ships in browser
bundles, and RLS is the authorization boundary (`registry.ts` says so at its declaration). It is
an *operational* hazard: rotating that key means locating and editing six files in five trees,
and nothing fails loudly if one is missed — the stale copy just starts 401ing at runtime for
whichever surface owns it.

`packages/platform-client` is the shared platform access layer and is the natural single owner.
Consolidating is not free: `prompt-organizer`'s copy sits in a plain `index.html` that cannot
import a TS package, and not every consumer currently depends on `platform-client`. Treat this
as a known hazard to fix deliberately, and if you rotate the key before then, change all six.

## Owner authority

The OWNER is `kgsmith19`, or an explicit instruction authenticated as coming from the owner. The
standard governs agents by default. The owner governs the standard.

Precedence order:

1. Current explicit owner instruction
2. Owner-authorized GitHub Issue and its acceptance criteria
3. This `AGENTS.md`
4. `project.yaml`
5. Pinned shared standard from `standard.lock`
6. Harness and provider defaults

The owner may override, replace, suspend, or delete any part of this document at any time. An
agent MUST NOT lecture, argue with, reverse, or repeatedly warn about an explicit owner decision;
technical risks may be stated once, concretely, without obstruction. When a check is waived by
owner instruction, report it once as: "Not run by owner instruction."

## Sources of truth

| Information | Source of truth |
| --- | --- |
| Agent and engineering rules | `AGENTS.md` (this file) |
| Claude / Gemini compatibility | `CLAUDE.md` / `GEMINI.md` (import-only) |
| Repository facts and exact commands | `project.yaml` |
| Per-app facts and commands | that app's own `AGENTS.md` / `project.yaml` under `apps/<name>/` |
| Work intent and acceptance criteria | GitHub Issue |
| Implementation evidence and handoff | Pull request |
| Execution history | GitHub Actions (root `.github/workflows/`) |
| Product behavior | Code and tests |
| Adopted standard revision | `standard.lock` |

Do not add a root `TODO.md`, a `ROADMAP.md` work tracker, a root `TEST_LEDGER.md`, committed
implementation plans or session transcripts, permanent design documents or ADRs, or a duplicate
status database. Nested per-app `TEST_LEDGER.md` files (owned by each app's own upstream repo)
are unaffected by this rule.

## Session bootstrap

At the start of every new, resumed, or post-compaction controller session:

1. Read this `AGENTS.md`, then `project.yaml`.
2. Identify the active GitHub Issue, branch, PR, and exact head.
3. Detect whether the environment is already isolated (worktree, container).
4. Run the affected PR Gate's local-equivalent commands (see `project.yaml`) before modifying
   code, to establish a clean baseline.
5. Resume the first incomplete task rather than repeating completed work.

Superpowers lifecycle skills (worktrees, writing plans, subagent-driven development,
test-driven development, systematic debugging, code review, verification before completion,
finishing a branch) are used when the harness provides them. When unavailable: record
"Superpowers unavailable in this harness" and follow the equivalent process manually — isolated
worktree, gitignored local plan, RED then GREEN then REFACTOR, fresh task-focused contexts, task
and final review, fresh verification before completion.

Local plans, briefs, and ledgers live only in gitignored workspaces (`.superpowers/`,
`.agent-runtime/`); nothing drafted there may be committed. The Issue is the durable artifact.

## Provider-neutral roles

- Owner — controls intent and may override anything.
- Controller — coordinates the Issue, worktree, tasks, subagents, evidence, and recovery state.
- Builder — implements one bounded task or slice.
- Test Designer — challenges acceptance criteria and designs defect-sensitive evidence.
- Verifier — independently challenges intent interpretation, tests, implementation, security,
  structure, and exact-head evidence.
- Investigator — researches, reproduces, traces, or measures without implementation authority.

For R2/R3 work: prefer a different provider family for verifier versus builder, require
exact-head verification, and record the provider family and model. The owner may waive provider
separation; harnesses limited to a single provider family record that waiver explicitly.

## Releases and milestones

A GitHub Milestone defines a release. Use an existing open release milestone when one is clearly
applicable; otherwise create `vNext`. Release state is read from the milestone: open Issue = not
completed; `status:ready` = available; `status:active` = claimed; linked PR = in progress;
`status:blocked` = blocked; closed by merged PR = completed; closed as not planned or duplicate =
excluded, not delivered.

## Thin Issues and work claiming

One Issue represents one observable outcome. Split an Issue when it contains multiple
independently valuable outcomes, crosses unrelated apps/services, needs multiple writers in the
same files, exceeds roughly five behavior claims, or cannot be reviewed in one focused pass. A
change scoped to a single `apps/<name>/` or `services/<name>/` tree should generally stay inside
that tree's own PR Gate's path filter.

Standard labels: `status:ready`, `status:active`, `status:blocked`; `risk:R0` through `risk:R3`;
`owner:allow-draft`, `owner:hold-merge`, `owner:policy-change`. Owner-prefixed labels are trusted
only when applied by the owner.

Claim protocol:

1. Confirm the Issue is open, `status:ready`, not `status:blocked`, and has no open PR
   implementing it.
2. Resolve the exact current `main` SHA.
3. Construct branch `issue/<issue-number>-<short-slug>` and, when isolation is needed, worktree
   `.worktrees/issue-<issue-number>-<short-slug>`.
4. Create the remote branch via the GitHub ref-creation API (atomic claim). "Reference already
   exists" is a failed claim.
5. Add `status:active`, remove `status:ready`.
6. Create or update exactly one managed Work State comment (marker
   `<!-- agent-engineering-standard:work-state:v1 -->`) on the Issue.

## Worktrees and parallel work

Every implementation Issue uses an isolated worktree unless the harness already provides an
isolated workspace. The repository `.gitignore` contains `.worktrees/`, `.superpowers/`,
`.agent-runtime/`, and `.evidence/`.

Exactly one implementation writer per worktree at a time. Parallelize only independent Issues
touching unrelated apps/services, or read-only research and verification. Never parallelize
writers that touch the same files, share mutable state (e.g. Supabase migrations), or alter the
same schema/contract. When uncertain, execute sequentially.

Cleanup: preserve worktrees with open PRs. After a merged PR, remove the worktree only when
merged, clean, nothing unpushed, and no active writer is recorded. Preserve closed-unmerged work
unless the owner says otherwise.

## Context recovery and subagent tracking

Task states: DISPATCHING, ACTIVE, COMPLETE, BLOCKED, UNKNOWN. Never convert UNKNOWN to COMPLETE
by assumption. Never dispatch a second writer into a worktree while an earlier writer may still
be active.

Recovery after restart or compaction: read the Issue, its PR, and the Work State comment; run
`git worktree list --porcelain`, `git status`, and `git log`; compare local and remote heads;
resume the first task without a valid COMPLETE record. Trust Git and verified GitHub state over
model recollection.

## Risk classification

Every Issue carries exactly one tier:

- R0 — mechanical.
- R1 — local and reversible.
- R2 — shared, integrated, or stateful.
- R3 — critical, privileged, destructive, financial, security-sensitive, concurrent, or
  irreversible. A change to any root `.github/workflows/*.yml`, `deploy.yml`,
  `platform-*.yml`, `CODEOWNERS`, or the Supabase publishable-key hazard's six files is at
  minimum R2, and R3 when it touches gate aggregation, merge automation, or deploy/migration
  behavior directly.

Verification scales with tier per the pinned standard's own Risk classification section. The
owner may override any tier or mechanism.

## Intent and behavioral claims

Issues state falsifiable behavior claims, invariants that must remain true, and outcomes that
must never happen. Evidence maps one-to-one to claims. For R2/R3 behavior touching a PR Gate or
`merge-policy.yml`, record at least one sensitivity demonstration in the PR (RED before
implementation, a deliberate negative control, or a plausible targeted mutation).

## Test quality

Every new or materially changed test must satisfy: behavior relevance; failure sensitivity; an
independent oracle; the least expensive adequate level; determinism; diagnostic clarity; and
marginal value. Empty-green tests are prohibited (assertionless tests, swallowed exceptions,
tests that cannot fail, coverage-only tests). A green suite is evidence only when its tests can
reject wrong behavior. Each app's own test suites (`apps/<name>/`, `services/<name>/`) are
authoritative for that app's testing conventions; this section governs root-level and
cross-cutting changes.

## Verification flow

Owner intent → thin implementation Issue → behavior claims and forbidden outcomes → risk
classification → RED or negative control → smallest coherent implementation → the relevant PR
Gate(s) (lint/build/tests per the affected app or service, plus any root-level checks) →
independent exact-head verification for R2/R3 → the required PR Gate(s) green → native squash
auto-merge → worktree cleanup after merge.

Before every PR: `git status --short`, `git diff --check`, every applicable local command
documented in `project.yaml` or the affected app's own `project.yaml`. Inspect the full diff,
recent log, and `git worktree list --porcelain`. Confirm one active writer, the correct Issue and
deterministic branch, no unrelated files, and that the PR is ready, not draft.

Oracle-change firewall: every PR discloses removed tests, weakened assertions, changed expected
values, broadened snapshots, new skips, reduced verification scope, changed CI or security
behavior, changed permission boundaries — or states "None."

## Evidence and artifacts

For UI-visible behavior changes, prefer screenshots or a short recorded verification note in the
PR. For CI/workflow changes, the relevant PR Gate's own run (with its step summary) is the
evidence of record — link the run in the PR. Never expose secrets, tokens, or private data in
PR bodies, comments, or artifacts.

## Lean engineering

Optimize for minimum accidental complexity, not minimum raw LOC. Precise domain names; stable
responsibility boundaries; one conceptual level per method; minimal exported surface; deletion of
dead code exposed by the change; one source of truth per concept; small coherent diffs; no
unrelated cleanup. Do not enforce arbitrary global limits on LOC, file length, or folder depth.

## Documentation and handoff

Keep `README.md`, this `AGENTS.md`, and `project.yaml` consistent with actual behavior in the
same PR as the change. `CLAUDE.md` and `GEMINI.md` contain only the import line; never duplicate
policy inside a provider adapter.

When stopping before a PR exists, leave a Work State comment on the Issue: branch, exact head,
completed, remaining, current failure, last verified command, exact next command. Once a PR
exists, the PR is the handoff.

## PR Gate and merge behavior

This repository uses **six independent, path-scoped required checks** rather than one
repo-wide aggregator — a deliberate, owner-directed adaptation for this monorepo's shape:

| Gate | Workflow | Covers |
| --- | --- | --- |
| `Toolbelt PR Gate` | `toolbelt-ci.yml` | `apps/toolbelt/**` |
| `ACC PR Gate` | `acc-ci.yml` | `apps/agentic-command-center/**`, `apps/toolbelt/guards/**` |
| `Brain PR Gate` | `brain-ci.yml` | `services/brain/**` |
| `Shell PR Gate` | `shell-ci.yml` | `apps/shell/**`, `packages/**`, `services/llm-handler/**`, `docs/ops/**` |
| `LifeOS PR Gate` | `lifeos-ci.yml` | `apps/lifeos/**` |
| `Gitleaks` | `secret-scan.yml` | whole repo, every PR (deliberate exception: no path filter, generic name) |

A PR is required to pass only the gates whose paths its diff touches (GitHub's own required-check
semantics: a check not triggered for a PR is not required for that PR). Each gate is, within
itself, fail-closed: a real aggregator job with `if: always()`, full `needs:` coverage, and
explicit strict success-checking.

`merge-policy.yml` is operational metadata automation, not a required status check: it never
checks out, fetches, or executes PR-controlled code, never direct-merges, and maintains only the
managed Work State and Evidence Index comments. For ready same-repository PRs to `main` it
enables native squash auto-merge bound to the expected head, re-arms it when disabled without an
owner hold, and never bypasses any gate.

`main` protection: pull request required, squash only, linear history, no force push, no
deletion, code-owner approval required for control-plane files (see `.github/CODEOWNERS`), owner
bypass.

Agents create ready PRs — never drafts, never converting to draft; incomplete work remains on the
branch until ready.

## Agent boundaries

Agents may, only when the task explicitly authorizes them: create work artifacts — Issues,
branches, commits, pull requests, descriptions, code, tests, and documentation.

Agents must not: submit reviews, request reviewers, approve changes, block a pipeline, post
unsolicited comments, push implementation directly to `main`, bypass a failing PR Gate, weaken a
test or oracle merely to obtain green status, use administrative bypass without explicit owner
authorization, store credentials in the repository, or claim completion without fresh
verification evidence.

## Completion standard

Work is complete only with fresh evidence at the exact head: every acceptance criterion
satisfied; local verification and the relevant PR Gate(s) green on the exact tested head;
independent verification recorded for R2/R3; no silently weakened oracle; and the Issue closed by
the merged PR. Never report completion while any required verification or acceptance criterion
remains unresolved.
