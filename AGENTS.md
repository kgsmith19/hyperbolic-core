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

## Active agent roles

This repo has exactly two automation roles, **dev** and **review**, each bound to one model
vendor at a time by `agent-roles.yaml` at the repo root. Read that file now, before doing
anything else in this session.

- **About to write code, push a commit, or open/update a pull request?** You must be the vendor
  named under `dev`. If you are not, stop and say so plainly to whoever is directing you, naming
  the vendor that *is* currently assigned, before writing anything. Proceed only on their explicit
  instruction to override — that is the owner's call to make, not yours.
- **About to post a review verdict, or claim to speak as "the" reviewer, on a PR in this repo?**
  Same rule, against `review`.
- This is an instruction, not a technical lock — nothing stops a determined session from ignoring
  it. It exists because every agent capable of working in this repo is built to honor `AGENTS.md`,
  and honoring it here is exactly as mandatory as honoring any other rule in this file.
- `dev.provider` and `review.provider` are different value spaces, not one enum reused twice.
  `dev.provider` names the coding-agent **tool/harness** that writes code and drives pull
  requests — `anthropic | openai | antigravity` (Claude Code, Codex, or Antigravity, Google's
  agentic CLI and the deprecated Gemini CLI's successor). `review.provider` names the raw model
  **API family** the structured-output review call targets — `anthropic | openai | gemini`.
  `AI Review` is one sandboxed LLM call via `packages/llm` (see `packages/review/src/config.ts`);
  it never runs an agent harness, so `gemini` there is the real Gemini API — the same one
  `services/brain` and `services/llm-handler` call for product features, unrelated to Antigravity.
- The two values in `agent-roles.yaml` must never be equal. `repository-standards` enforces this
  mechanically: `.github/actions/verify-repo-policy` validates the file on every PR — it must
  parse, `dev.provider` and `review.provider` must each be valid for their own value space above,
  both must name a non-empty `model`, and the two providers must differ (the spaces only overlap
  on `anthropic`/`openai`, exactly where a real collision — the same family both writing and
  reviewing — can still happen). Any violation fails the whole `PR Gate` closed — a role collision
  or a malformed file blocks every PR, not just one that touches this file. This is the first of
  three independent checks of the same constraint; the dev dispatcher and the reviewer gate each
  re-verify it too, once those slices land.

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
`owner:allow-draft`, `owner:hold-merge`, `owner:allow-incomplete-issue`, `owner:policy-change`.
Owner-prefixed labels are trusted only when applied by the owner.

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
a pull request. **Every job in it is a native job**, each producing exactly one check row with its
exact bare name. Nothing there uses `workflow_call`; the real work lives in composite actions under
`.github/actions/`, which run *inside* the calling job and so add no rows of their own.

The architecture, by explicit owner directive: **Repository Standards verifies the repository. Each
app verifies itself. AI Review independently evaluates the change. PR Gate verifies that every
mandatory lane succeeded and alone controls merge authorization.** Nine rows total, only one
required: `PR Gate`.

| Order | Gate | Covers | Required |
| --- | --- | --- | --- |
| 1 | `Repository Standards` | whole repo — leaked-credential scan, repo structure, PR description, exact-head consistency. Repository integrity only; no app-specific check belongs here | No — rolled into `PR Gate` |
| 1 | `Toolbelt` | `apps/toolbelt/**`, `packages/toolbelt-cli/**` | No — rolled into `PR Gate` |
| 1 | `ACC Linux` | `apps/agentic-command-center/**`, `apps/toolbelt/guards/**` — Linux-native suites and covgate | No — rolled into `PR Gate` |
| 1 | `ACC Windows` | the same ACC paths — PowerShell/native suites that need `windows-latest` | No — rolled into `PR Gate` |
| 1 | `Brain` | `services/brain/**` | No — rolled into `PR Gate` |
| 1 | `Platform` | `apps/shell/**`, `packages/**`, `services/llm-handler/**`, `services/broker/**`, `docs/ops/**` | No — rolled into `PR Gate` |
| 1 | `LifeOS` | `apps/lifeos/**` — including its own lint | No — rolled into `PR Gate` |
| 2 | `AI Review` | whole repo — adversarial LLM review of the diff against the Issue and this file; `needs:` Repository Standards only | No — rolled into `PR Gate` |
| 3 | `PR Gate` | rollup **and** merge orchestration: `needs:` every lane above, `if: always()` | **Yes** |

**One check row per job is a GitHub invariant with no suppression mechanism.** By owner directive
this repository optimizes the opposite way from a minimal checks list: the seven worker lanes
(Repository Standards plus six app lanes) all start **in parallel at T=0**, each self-contained and
independently owned, because clear ownership, faster wall-clock, isolated runners, and easy app
onboarding are worth more here than a short checks list. The abstraction "one required check" lives
entirely at the final aggregation layer — `PR Gate` — not in how many jobs run underneath it.
Fail-fast ordering is preserved **inside** each lane — a failing step stops that job — and a
lane's failure shows as its own row with its own log, which is the whole point of splitting them:
open the failing lane directly instead of one shared job log.

`ACC Windows` cannot join `ACC Linux`: one job runs on one runner image, and ACC's PowerShell
shim, cap-watcher and installer suites need `windows-latest`. That is a platform constraint, not an
oversight. Both ACC rows run their **own** change detection through the shared `detect-changes`
composite action rather than depending on each other.

**Every lane exists and reports on every PR — mandatory reporting, not a job-level path
condition.** Relevance comes from `.github/actions/detect-changes` *inside* each job, never from a
`paths:` filter on the workflow, which is what keeps the required check reporting on *every* PR. An
app untouched by a given PR still runs its lane's job; the lane detects irrelevance and reports
success via an explicit "not applicable" step in seconds, rather than the job disappearing. That
keeps `PR Gate`'s own logic trivially simple: every expected dependency exists and must conclude
exactly `success`. A change to `.github/workflows/**` or `.github/actions/**` marks **every** app
relevant, so a CI edit is exercised end to end rather than trivially passing against untouched apps.

`PR Gate` is the rollup: `needs:` every lane above, `if: always()` so it still reports when one
failed rather than being skipped, and its verdict comes straight from this workflow's own
`needs.*.result` — no check-runs API round trip, no name matching, nothing to keep in sync with a
list elsewhere. Anything that is not exactly `success` fails it, so a lane that mistakenly stops
reporting (`skipped`, `cancelled`) turns the rollup **red, not green**. It is the **only** name in
the branch ruleset's required-status-checks list. One name instead of many is one fewer thing to
drift out of sync with this file — the exact failure mode that stranded PRs #118, #120 and #160 on
stale required-check lists.

`AI Review` needs **Repository Standards, and only Repository Standards** — not the app lanes. The
leaked-credential scan must finish before any diff content is sent to an external model provider;
waiting on the app suites too would serialize the pipeline for no matching security benefit. By
**explicit owner decision** `AI Review` **is** in `PR Gate`'s `needs:` — a reversal of this
repository's earlier policy, made deliberately as part of this architecture. A provider outage,
an Infisical failure, or a valid blocking finding therefore stops auto-merge on every PR until
resolved; the owner's ruleset bypass remains the escape hatch, and no agent may use it on the
owner's behalf. If Repository Standards fails, GitHub skips `AI Review` outright (its own `needs:`
failed), which surfaces as `result: "skipped"` — and `PR Gate`'s allow-list treats that exactly
like any other non-`"success"` result: a failure, never a silent pass.

The `LifeOS` lane runs only LifeOS's own lint commands (`ruff check` for the backend, `npm run
lint` for the frontend), early in each half of its suite, ahead of `mypy`/`pytest` and the
type-check/e2e/build steps — because LifeOS is the only app in this repo with a lint command
configured, see `apps/lifeos/AGENTS.md`. Lint lives directly inside
`.github/actions/verify-tests-lifeos/action.yml`, not a separate composite action: each app's own
lane is the natural home for its lint once that lane already runs its full suite. Extend that
action in place, not a second gate, when another app adopts a linter.

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
> **There is no separate merge-policy workflow.** Arming native squash auto-merge, maintaining the
> managed Work State comment, and enforcing `owner:hold-merge` / `owner:allow-draft` all live in
> the `PR Gate` job itself. That makes "the last gate finishing is the only thing that can enable a
> merge" true *by construction* rather than by a re-read of the check-runs API: arming is a later
> step of the very job that computes the verdict, so it is unreachable unless every lane already
> succeeded.
>
> Two consequences of that shape are deliberate and worth knowing. **Fork pull requests get neither
> the managed comment nor auto-merge arming**: a `pull_request` workflow gets a read-only token for
> forks, and arming is restricted to same-repository PRs. **`PR Gate` is the one job in the
> workflow holding a write token**, so it performs no checkout and runs no shell over repository
> content — it only calls `actions/github-script` against `context.payload` and API responses.
> Every sibling job that *does* execute pull-request-authored code holds only the read-only
> workflow default. Keep it that way.
>
> The "Required" column above is this document's specification of the correct configuration —
> applying it to the live ruleset is a manual owner action outside this repository's files (no
> ruleset-write API is available to an agent in this harness) and may lag a commit or two behind
> this table. **Read the live ruleset itself, never this table alone, to know what is actually
> enforced at any given moment**, and confirm any name against a real PR's Checks tab before
> entering it.

Each gate's real work lives in a composite action under `.github/actions/` — `verify-secrets`,
`verify-repo-policy`, `verify-pr-description`, `verify-tests-toolbelt`, `verify-tests-acc`,
`verify-tests-acc-windows`, `verify-tests-brain`, `verify-tests-shell`, `verify-tests-lifeos`,
`verify-llm-review`. Each is also reused by the matching standalone
workflow file (`secret-scan.yml`, `repo-policy.yml`, `template-lint.yml`, `toolbelt-ci.yml`,
`acc-ci.yml`, `brain-ci.yml`, `shell-ci.yml`, `lifeos-ci.yml`, `llm-review.yml`) for that file's
own `merge_group`/`push`/`workflow_dispatch` triggers, so every check has exactly one source of
logic despite two trigger paths. A composite action's own `action.yml` must be on disk before it
can be resolved, so **every job referencing one checks out the repository first** — omitting that
fails with "Can't find 'action.yml' … Did you forget to run actions/checkout?".

### Independent LLM Review

`AI Review` runs an adversarial LLM reviewer (`packages/review`, built on this repo's own
`@hyperbolic/llm`) against each PR's diff, its linked Issue, and this file. It is **not** GitHub's
native code review: this repository does not use approving reviews, Request Changes, or
CODEOWNERS review gating. GitHub runs the job and reports a status check — exactly its role for
`Repository Standards`. The judgment lives in this repo's own tooling.

- **Provider separation is enforced, not preferred.** The reviewer's provider family must differ
  from the builder's; the gate fails closed when they match. Provider identifiers are
  case-insensitive and canonicalized to lowercase at one boundary (`packages/review/src/config.ts`)
  before this comparison runs, so a repository variable like `REVIEW_PROVIDER=OPENAI` cannot slip
  past validation on casing alone, and casing can never smuggle a same-family pairing past the
  separation guard either.
- **The model receives a structured-output tool and nothing else** — no shell, filesystem-write,
  or network access. Repository content under review is data, never instructions. Injected text
  can at worst skew a verdict; it cannot execute anything or reach a credential.
- **Every finding requires concrete evidence and a citation** to a specific acceptance criterion
  or a named section of this file. Uncited, evidence-free findings are discarded and **cannot
  block** — a confused model must never stall real work.
- **Fail-closed vs. fail-open:** infrastructure failure (missing credential, unset
  `REVIEW_MODEL`, invalid provider configuration, API error, timeout) fails the gate; a weak or
  malformed model answer does not.
- Findings are published to the run's job summary, and also posted into the pull request as
  **exactly one managed comment** (marker `<!-- agent-engineering-standard:llm-review:v1 -->`,
  updated in place per head — never a new comment per run), by `llm-review-dialogue.yml` (Issue
  #231). That workflow triggers on `workflow_run`, not `pull_request`, so it adds no PR check row,
  and it holds `pull-requests: write` under the same discipline as `PR Gate`: no checkout, no shell
  over repository content, only `actions/github-script` against a downloaded artifact and the API.
  `AI Review` itself stays read-only — the artifact is the only thing that crosses the boundary,
  and the PR number it names is verified against the triggering run's own head SHA before anything
  is posted.
- The managed comment posts under the reviewer's **own GitHub App identity** (Issue #272), minted
  from `REVIEW_GITHUB_APP_ID`/`REVIEW_GITHUB_APP_PRIVATE_KEY` in Infisical's `/review/` path —
  the same identity and secret path `verify-llm-review` already reads model provider keys from —
  via `actions/create-github-app-token`, the identical mechanism `dev-agent-dispatch.yml` uses for
  the dev identity. This is a visibility improvement, not a gate: `llm-review-dialogue.yml` only
  *delivers* findings someone else already computed, so an unprovisioned or failing App credential
  degrades to posting under `github-actions[bot]` instead (`continue-on-error: true` on both the
  Infisical pull and the token mint), logged loudly via `core.warning` and the run summary, never
  silently. Findings reaching the pull request is the invariant that must never break; which
  identity they post under is not.
- The comment carries a **round counter**: it increments when a new head still leaves a blocking
  finding open, holds steady on a same-head re-run, and resets on a passing verdict. A blocking
  finding wakes the developer agent via `repository_dispatch` (`dev-agent-dispatch.yml`) — the
  documented exception to `GITHUB_TOKEN`'s recursion prevention, needing no PAT or long-lived
  credential beyond the agent's own model key — which fixes the finding, pushes, and lets the
  gates re-run, or rebuts it in the same comment thread, argued from the work item, this standard,
  and the diff, objectively and never from taste. A comment-only reply pushes no commit, so
  `pull_request:synchronize` never fires to retrigger `AI Review` on its own; `dev-agent-dispatch.yml`'s
  own last step detects that its dispatched head is still current at the end of its run and fires a
  second `repository_dispatch` (`llm-review-recheck.yml`), the same documented exception, which
  re-runs the identical `verify-llm-review` composite action `AI Review` uses — one source of
  review logic across both trigger paths — so a rebuttal or a deferral proposal gets scored without
  waiting for an unrelated commit to happen to land.
- After a configurable number of unresolved rounds (`vars.LLM_REVIEW_ESCALATE_AFTER`, default 3)
  with the gate still red, the comment tags `@kgsmith19` once and states the unresolved
  disagreement plainly — the documented rare escape hatch, not the normal path. The same
  escalation fires immediately, without waiting on the round threshold, if the agent-wake
  credential is unprovisioned or the dispatch itself fails: a loop that cannot advance must not
  stall silently behind a counter that will never tick. This matters more now that `AI Review` is
  a `needs:` dependency of `PR Gate` (below) — an unresolved blocking finding stops auto-merge for
  real, not just cosmetically, so a disagreement that cannot resolve itself must reach the owner
  rather than stall.

> [!IMPORTANT]
> **No agent review may block the owner.** `AI Review` is mandatory in substance — it is a
> dependency of `PR Gate`, the sole required check, so a red or skipped review does stop auto-merge
> — but `main` protection retains owner bypass, so `kgsmith19` may merge over a red review at any
> time. An agent MUST NOT re-litigate, reverse, or open an unsolicited Issue against that decision.

Merge orchestration is the last step of `PR Gate` in `pr-verify.yml`. It never checks out, fetches,
downloads, or executes PR-controlled code, and never direct-merges: for ready same-repository PRs
to `main` whose verdict is green it enables native squash auto-merge bound to the expected head,
and it maintains the managed Work State comment. Because the workflow also triggers on
`auto_merge_disabled`, `labeled` and `unlabeled`, arming is re-evaluated when auto-merge is switched
off without an owner hold, and an `owner:hold-merge` label applied by the owner disables it again
on the next run.

> [!NOTE]
> That reactivity costs a pipeline run for every label change, body edit, draft toggle, or
> auto-merge switch-off, because those events must re-run the workflow that contains the
> orchestration. With the lanes parallel, a re-trigger on an unchanged head costs wall-clock equal
> to the slowest relevant lane rather than the sum of every suite. `cancel-in-progress` bounds it
> further — rapid successive edits cancel the superseded run rather than queueing another. Weigh
> this before adding another event to `pr-verify.yml`'s `types:` list.

`PR Gate` also fails closed — a real, visible check failure, not a quiet arm-skip like draft or
hold — when any Issue the PR's body references with a closing keyword (`Closes`/`Fixes`/`Resolves
#N`; every one referenced, not just the first) is still **open** and its body has at least one
unchecked `- [ ]` item (Issue #274). An Issue closed for any reason, including GitHub's native "not
planned" state — this repo's own existing convention for superseded or no-longer-relevant work,
see Releases and milestones above — is exempt entirely; only an open Issue with unchecked items
blocks. The owner overrides per-PR with the `owner:allow-incomplete-issue` label, verified with the
exact same timeline-provenance check as `owner:hold-merge`/`owner:allow-draft`: present without an
authorizing `labeled` event from the owner, it is removed rather than honored. A per-Issue read
failure (bad number, deleted Issue, a transient API error) does not itself block — it is reported
in the job summary as unverifiable, matching this job's existing tolerance for orchestration
errors elsewhere, rather than wedging every PR shut on a typo or a momentary API blip.

`.github/CODEOWNERS` requires `@kgsmith19` review for this repo's control-plane paths
(`.github/CODEOWNERS`, `.github/workflows/`, `project.yaml`, `agent-roles.yaml`). `main` protection: pull request
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
