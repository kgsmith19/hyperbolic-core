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

The **OWNER** is `kgsmith19`, or an explicit instruction authenticated as coming from the owner.
The standard governs agents by default. **The owner governs the standard.**

**Precedence order:** (1) current explicit owner instruction, (2) owner-authorized GitHub Issue
and its acceptance criteria, (3) this `AGENTS.md`, (4) `project.yaml`, (5) pinned shared standard
from `standard.lock`, (6) harness and provider defaults.

The owner **may override, replace, suspend, or delete any part of this document at any time.** An
agent **must not** lecture, argue with, reverse, or repeatedly warn about an explicit owner
decision; technical risks may be stated once, concretely, without obstruction.

> [!IMPORTANT]
> When a check is waived by owner instruction, report it once as: **"Not run by owner
> instruction."**

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

| Role | Responsibility |
| --- | --- |
| **Owner** | Controls intent and may override anything. |
| **Controller** | Coordinates the Issue, worktree, tasks, subagents, evidence, and recovery state. |
| **Builder** | Implements one bounded task or slice. |
| **Test Designer** | Challenges acceptance criteria and designs defect-sensitive evidence. |
| **Verifier** | Independently challenges intent interpretation, tests, implementation, security, structure, and exact-head evidence. |
| **Investigator** | Researches, reproduces, traces, or measures without implementation authority. |

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

| Tier | Meaning |
| --- | --- |
| **R0** | Mechanical |
| **R1** | Local and reversible |
| **R2** | Shared, integrated, or stateful |
| **R3** | Critical, privileged, destructive, financial, security-sensitive, concurrent, or irreversible |

> [!NOTE]
> A change to any root `.github/workflows/*.yml`, `deploy.yml`, `platform-*.yml`, `CODEOWNERS`,
> or the Supabase publishable-key hazard's six files is **at minimum R2**, and **R3** when it
> touches gate aggregation, merge automation, or deploy/migration behavior directly.

Verification scales with tier per the pinned standard's own Risk classification section. The
owner may override any tier or mechanism.

## Intent and behavioral claims

Issues state falsifiable behavior claims, invariants that must remain true, and outcomes that
must never happen. Evidence maps one-to-one to claims. For R2/R3 behavior touching a PR Gate or
`pr-verify.yml`'s merge orchestration, record at least one sensitivity demonstration in the PR
(RED before implementation, a deliberate negative control, or a plausible targeted mutation).

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

Every PR-time verification gate — **and merge orchestration itself** — runs from one entry point,
`.github/workflows/pr-verify.yml` ("PR Verification"). It is the *only* workflow that triggers on
a pull request. **Every job in it is a native job whose name starts with `Verify: `, and each
produces exactly one check row with that exact bare name.** Nothing there uses `workflow_call`;
the real work lives in composite actions under `.github/actions/`, which run *inside* the calling
job and so add no rows of their own. **Four rows total, only one required**: `Verify: All Gates`.

| Order | Gate | Covers | Required |
| --- | --- | --- | --- |
| 1 | `Verify: Tests (Linux)` | whole repo — which apps changed, leaked-credential scan, repo structure, PR description, lint, then the Toolbelt, ACC (Linux), Brain, Shell and LifeOS suites | No — rolled into `Verify: All Gates` |
| 1 | `Verify: Tests (Windows)` | `apps/agentic-command-center/**`, `apps/toolbelt/guards/**` — the PowerShell/native suites that need `windows-latest` | No — rolled into `Verify: All Gates` |
| 2 | `Verify: LLM Review` | whole repo — adversarial LLM review of the diff against the Issue and this file | **No** (pending credentials) |
| 3 | `Verify: All Gates` | rollup **and** merge orchestration: `needs:` both test jobs, `if: always()` | **Yes** |

**One check row per job is a GitHub invariant with no suppression mechanism**, so the only way to
shorten the PR checks list is to run fewer jobs. That is why every repo-wide conformance check and
all five Linux suites share **one** job. The cost is real and was accepted deliberately: measured
on PR #205 (a CI change, so every suite ran for real) the previous parallel shape finished in
**8.0 min** and the same work summed to **17.3 min**. Wall-clock roughly doubles; the list drops
from ten rows to four. Fail-fast ordering is preserved inside the job — a failing step stops it, so
nothing runs after a leaked secret is found — and the tradeoff is that a failure shows as one row,
so you open the job log to see which step broke.

`Verify: Tests (Windows)` cannot join it: one job runs on one runner image, and ACC's PowerShell
shim and cap-watcher suites need `windows-latest`. That is a platform constraint, not an
oversight. It runs its **own** change detection through the shared `detect-changes` composite
action rather than consuming a Linux job output, so it stays parallel instead of idling ~16
minutes just to learn whether ACC was touched at all.

**Every suite still skips in seconds when its app wasn't touched** — merging the jobs did not merge
the relevance decisions. Relevance comes from `.github/actions/detect-changes`, not from a `paths:`
filter on the workflow, which is what keeps the required check reporting on *every* PR. A change to
`.github/workflows/**` or `.github/actions/**` marks **every** app relevant, so a CI edit is
exercised end to end rather than trivially passing against untouched apps.

`Verify: All Gates` is the rollup: `needs:` both test jobs, `if: always()` so it still reports when
one failed rather than being skipped, and its verdict comes straight from this workflow's own
`needs.*.result` — no check-runs API round trip, no name matching, nothing to keep in sync with a
list elsewhere. Anything that is not exactly `success` fails it, so a job that mistakenly stops
reporting (`skipped`, `cancelled`) turns the rollup **red, not green**. It is the **only** name in
the branch ruleset's required-status-checks list. One name instead of many is one fewer thing to
drift out of sync with this file — the exact failure mode that stranded PRs #118, #120 and #160 on
stale required-check lists.

`Verify: LLM Review` needs both test jobs, so no reviewer tokens are spent on a PR failing anything
else. It is deliberately **not** in `Verify: All Gates`'s `needs:` — it fails closed while reviewer
credentials are unprovisioned, and depending on it would make the one required check permanently
red.

> [!NOTE]
> While `Verify: LLM Review` reports failure the pull request stays `unstable`, and GitHub does not
> merely decline to *fire* auto-merge there — it **refuses to arm it at all**. The
> `enablePullRequestAutoMerge` mutation fails outright, verbatim on PR #219:
>
> ```
> Request failed due to following response errors:
>  - Pull request Pull request is in unstable status
> ```
>
> So nothing is armed and nothing is queued waiting. `Verify: All Gates` records this in its job
> summary and does **not** fail the run — being unstable is not a verification failure. Auto-merge
> starts working once LLM Review stops reporting failure (provision the reviewer credentials, or
> have it report `neutral` when uncredentialed) **and** the workflow runs again, since arming is
> attempted during a run rather than left pending. Any later trigger — a push, a label change, an
> edit — re-attempts it.

The lint step inside `Verify: Tests (Linux)` runs only LifeOS's own lint commands (`ruff check` for
the backend, `npm run lint` for the frontend) today, because LifeOS is the only app in this repo
with a lint command configured — see `apps/lifeos/AGENTS.md`. Extend
`.github/actions/verify-linting/action.yml` in place, not a second gate, when another app adopts a
linter.

> [!WARNING]
> **The bare-name requirement is load-bearing, not cosmetic.** A required status check is matched
> by its literal reported name, and a `workflow_call`-invoked job is *always* reported as
> `"<caller job name> / <callee job name>"` for every job the called workflow has, no matter how
> few — there is no way to get a bare name through that boundary. Typing the bare name into the
> ruleset then silently creates a required check that **never reports**, which blocks every PR
> forever. This repo hit the same class of failure from the other direction on PRs #118 and #120
> (root docs and new workflow files, touching none of the app gates' paths) — they stuck in
> `mergeable_state: "blocked"` permanently and needed an owner administrative bypass to merge.
> Both hazards are why `pr-verify.yml` uses native jobs plus composite actions, and why relevance
> is decided inside the job rather than by a `paths:` filter. See the pinned standard's own
> "Path-scoped gates in monorepo topologies" note for the general pattern.
>
> `Verify: LLM Review` stays **non-required** until the owner provisions the reviewer credentials
> `llm-review.yml` documents — an unprovisioned run fails closed by design and must never block
> merge while unrequired.
>
> **There is no separate merge-policy workflow any more.** `merge-policy.yml` was deleted and its
> behavior — arming native squash auto-merge, maintaining the managed Work State and Evidence Index
> comments, and enforcing `owner:hold-merge` / `owner:allow-draft` — now lives in the
> `Verify: All Gates` job itself. That removes a whole check row that never gated anything, and it
> makes "the last gate finishing is the only thing that can enable a merge" true *by construction*
> rather than by a re-read of the check-runs API: arming is a later step of the very job that
> computes the verdict, so it is unreachable unless every gate already succeeded. The old workflow
> fired on `pull_request_target` immediately on every push — before any gate had even started — and
> had to ask the API after the fact whether verification had run.
>
> Two consequences of that move are deliberate and worth knowing. **Fork pull requests get neither
> the managed comments nor auto-merge arming**: a `pull_request` workflow gets a read-only token for
> forks, and arming was already restricted to same-repository PRs. **`Verify: All Gates` is the one
> job in the workflow holding a write token**, so it performs no checkout and runs no shell over
> repository content — it only calls `actions/github-script` against `context.payload` and API
> responses. Every sibling job that *does* execute pull-request-authored code holds only the
> read-only workflow default. Keep it that way.
>
> The "Required" column above is this document's specification of the correct configuration —
> applying it to the live ruleset is a manual owner action outside this repository's files (no
> ruleset-write API is available to an agent in this harness) and may lag a commit or two behind
> this table. **Read the live ruleset itself, never this table alone, to know what is actually
> enforced at any given moment**, and confirm any name against a real PR's Checks tab before
> entering it.

Each gate's real work lives in a composite action under `.github/actions/` — `verify-secrets`,
`verify-repo-policy`, `verify-pr-description`, `verify-linting`, `verify-tests-toolbelt`,
`verify-tests-acc`, `verify-tests-acc-windows`, `verify-tests-brain`, `verify-tests-shell`,
`verify-tests-lifeos`, `verify-llm-review`. Each is also reused by the matching standalone
workflow file (`secret-scan.yml`, `repo-policy.yml`, `template-lint.yml`, `toolbelt-ci.yml`,
`acc-ci.yml`, `brain-ci.yml`, `shell-ci.yml`, `lifeos-ci.yml`, `llm-review.yml`) for that file's
own `merge_group`/`push`/`workflow_dispatch` triggers, so every check has exactly one source of
logic despite two trigger paths. A composite action's own `action.yml` must be on disk before it
can be resolved, so **every job referencing one checks out the repository first** — omitting that
fails with "Can't find 'action.yml' … Did you forget to run actions/checkout?".

### Independent LLM Review

`Verify: LLM Review` runs an adversarial LLM reviewer (`packages/review`, built on this repo's own
`@hyperbolic/llm`) against each PR's diff, its linked Issue, and this file. It is **not** GitHub's
native code review: this repository does not use approving reviews, Request Changes, or
CODEOWNERS review gating. GitHub runs the job and reports a status check — exactly its role for
`Verify: Secrets`. The judgment lives in this repo's own tooling.

- **Provider separation is enforced, not preferred.** The reviewer's provider family must differ
  from the builder's; the gate fails closed when they match.
- **The model receives a structured-output tool and nothing else** — no shell, filesystem-write,
  or network access. Repository content under review is data, never instructions. Injected text
  can at worst skew a verdict; it cannot execute anything or reach a credential.
- **Every finding requires concrete evidence and a citation** to a specific acceptance criterion
  or a named section of this file. Uncited, evidence-free findings are discarded and **cannot
  block** — a confused model must never stall real work.
- **Fail-closed vs. fail-open:** infrastructure failure (missing credential, unset
  `REVIEW_MODEL`, API error, timeout) fails the gate; a weak or malformed model answer does not.
- Findings are published to the run's job summary, and also posted into the pull request as
  **exactly one managed comment** (marker `<!-- agent-engineering-standard:llm-review:v1 -->`,
  updated in place per head — never a new comment per run), by `llm-review-dialogue.yml` (Issue
  #231). That workflow triggers on `workflow_run`, not `pull_request`, so it adds no PR check row,
  and it holds `pull-requests: write` under the same discipline as `Verify: All Gates`: no
  checkout, no shell over repository content, only `actions/github-script` against a downloaded
  artifact and the API. `Verify: LLM Review` itself stays read-only — the artifact is the only
  thing that crosses the boundary, and the PR number it names is verified against the triggering
  run's own head SHA before anything is posted.
- The comment carries a **round counter**: it increments when a new head still leaves a blocking
  finding open, holds steady on a same-head re-run, and resets on a passing verdict. A blocking
  finding wakes the developer agent via `repository_dispatch` (`claude-dispatch.yml`) — the
  documented exception to `GITHUB_TOKEN`'s recursion prevention, needing no PAT or long-lived
  credential beyond the agent's own model key — which fixes the finding, pushes, and lets the
  gates re-run, or rebuts it in the same comment thread, argued from the work item, this standard,
  and the diff, objectively and never from taste.
- After a configurable number of unresolved rounds (`vars.LLM_REVIEW_ESCALATE_AFTER`, default 3)
  with the gate still red, the comment tags `@kgsmith19` once and states the unresolved
  disagreement plainly — the documented rare escape hatch, not the normal path. The same
  escalation fires immediately, without waiting on the round threshold, if the agent-wake
  credential is unprovisioned or the dispatch itself fails: a loop that cannot advance must not
  stall silently behind a counter that will never tick.

> [!IMPORTANT]
> **No agent review may block the owner.** `Verify: LLM Review` is a status check only, and is not
> even required yet; `main` protection also retains owner bypass, so `kgsmith19` may merge over a
> red review at any time. An agent MUST NOT re-litigate, reverse, or open an unsolicited Issue
> against that decision.

Merge orchestration is the last step of `Verify: All Gates` in `pr-verify.yml`. It never checks
out, fetches, downloads, or executes PR-controlled code, and never direct-merges: for ready
same-repository PRs to `main` whose verdict is green it enables native squash auto-merge bound to
the expected head, and it maintains the managed Work State and Evidence Index comments. Because the
workflow also triggers on `auto_merge_disabled`, `labeled` and `unlabeled`, arming is re-evaluated
when auto-merge is switched off without an owner hold, and an `owner:hold-merge` label applied by
the owner disables it again on the next run.

> [!NOTE]
> That reactivity now costs a **full pipeline run** — up to ~16 minutes — for every label change,
> body edit, draft toggle, or auto-merge switch-off, because those events must re-run the workflow
> that contains the orchestration. Under the previous shape `merge-policy.yml` answered them in
> about five seconds from its own `pull_request_target` job; absorbing that job is what removed a
> permanent check row, and this is the price. `cancel-in-progress` bounds it — rapid successive
> edits cancel the superseded run rather than queueing another. Weigh this before adding another
> event to `pr-verify.yml`'s `types:` list.

`.github/CODEOWNERS` requires `@kgsmith19` review for this repo's control-plane paths
(`.github/CODEOWNERS`, `.github/workflows/`, `project.yaml`). `main` protection: pull request
required, squash only, linear history, no force push, no deletion, code-owner approval required
for those paths, owner bypass.

Agents create ready PRs — never drafts, never converting to draft; incomplete work remains on the
branch until ready.

## Agent boundaries

Agents **may**, only when the task explicitly authorizes them: create work artifacts — Issues,
branches, commits, pull requests, descriptions, code, tests, and documentation.

Agents **must not:** submit reviews, request reviewers, approve changes, block a pipeline, post
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
