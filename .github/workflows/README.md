# CI/CD Workflows

CI, release, and PR-automation lanes for network-checker.

Three workflows run automatically on PR activity: `pr-gate.yml` (the one
required check) and the two thin callers into the pinned
`agent-engineering-standard` (`ai-review.yml`, `pr-automation.yml`). The
deep suites (`tests.yml`, `code-quality.yml`, `release.yml`) trigger on
`workflow_dispatch` only (manual, from the Actions tab) as of 2026-08-06 --
they no longer run automatically on every push or pull request. That was
burning through the account's Actions minutes quota (every push fired 3
workflows x up to 3 Python versions), and a quota-exhausted run fails
instantly with an empty log, which is indistinguishable from a real failure
unless you go check the job's `runner_id` via the API. Run `bash
tools/check.sh` locally instead -- see "Running Locally" below -- before
opening or merging a PR. Trigger a deep workflow manually from the Actions
tab only when you specifically want a GitHub-hosted run (e.g. to
double-check something before an admin merges).

## Workflows

### 1. PR Gate (`pr-gate.yml`)
The one required check. Runs `bash tools/check.sh` -- the same protected
gate you run locally -- for ready PRs and merge groups; a
documentation/governance-only diff keeps the check green without the full
suite.

**Triggers:** `pull_request` (non-draft), `merge_group`

---

### 2. AI Review Gate (`ai-review.yml`)
Thin caller into the pinned standard's `ai-review-reusable.yml`. No bespoke
jobs live here: both the `uses:` ref and the required `standard_sha` input
pin the exact commit recorded in `.agent/standard.lock`, so review-lane
behavior can never drift onto the standard's moving default branch. Comment
events are filtered to the AI reviewer bots' own `AI-REVIEW PASS`/`FAIL`
verdicts.

**Triggers:** `pull_request_review`, `pull_request_review_comment`,
`issue_comment` (bot-verdict-filtered)

---

### 3. PR Automation (`pr-automation.yml`)
Thin caller into the pinned standard's `pr-automation-reusable.yml`, pinned
the same way (`uses:` at the locked SHA + `standard_sha` input). The
reusable workflow owns the whole lane -- auto-merge arming,
independent-review requests, gate-result handling, and the hourly watchdog
-- so this repo carries no hand-rolled automation logic to drift.

**Triggers:** `pull_request_target`, `workflow_run` (PR Gate),
`pull_request_review`, `issue_comment` (bot-verdict-filtered), hourly
`schedule` (watchdog)

---

### 4. Tests (`tests.yml`)
Runs the stdlib unittest suite on Python 3.12, the declared target. No pip
install step, deliberately: netcheck is standard-library only (AGENTS.md).

**Triggers:** Manual (`workflow_dispatch`), or `workflow_call` from `release.yml`

---

### 5. Code Quality (`code-quality.yml`)
Runs `bash tools/check.sh` on a GitHub runner: the suite, the three quality
tools at the intensities `rules/01-BUDGETS.md` declares, and the shell
syntax checks -- one script, so local and CI cannot drift.

**Triggers:** Manual (`workflow_dispatch`)

---

### 6. Release (`release.yml`)
Builds and smoke-tests the Docker image, then opens a draft GitHub Release.

**Triggers:** Manual (`workflow_dispatch`) -- pick the `vX.Y.Z` tag to run
from in the "Use workflow from" dropdown. Pushing a tag no longer triggers
this by itself. Use `tools/deploy.sh` to build and smoke-test the image
locally without touching Actions at all, and only dispatch this workflow
when you actually want the published GitHub Release + artifact.

---

### 7. Apply Label Taxonomy (`apply-labels.yml`)
Seeds (or repairs drift in) the portfolio's shared label taxonomy --
`type:*`, `agent:*`, `priority:*`, `ci:full`, `release:requested`,
`status:*`, `risk:R0`-`risk:R4` -- so the automation lane, which keys on
`risk:*` and `status:*` labels, never meets a repo missing them. Idempotent:
existing labels are updated in place. Copied verbatim from the portfolio's
canonical seeder.

**Triggers:** Manual (`workflow_dispatch`)

---

## Dependabot

`.github/dependabot.yml` covers the `github-actions` ecosystem only, weekly,
with minor/patch updates grouped. There is nothing else for it to scan:
netcheck is standard-library-only Python with no pip manifest, by design.

---

## Branch protection note

`pr-gate.yml` runs automatically on pull requests and reports the `PR Gate`
check — the one check the portfolio-standard `Lean PR Gate` ruleset requires.
Do not configure `test` / `quality` as required status checks: those
workflows are `workflow_dispatch`-only and never report automatically, so a
PR requiring them would sit unmergeable forever (GitHub can't tell "not
required" from "required but never ran").

There is deliberately no native `.github/CODEOWNERS`: the standard's
zero-reviewer auto-merge lane requires it absent (the standard's doctor
flags "native CODEOWNERS present" as a defect, and a CODEOWNERS file would
re-request a human reviewer on every routine PR). Control-plane protection
comes from the pinned standard's control-plane path classification instead
-- PRs touching `.github/workflows/` or `.agent/` are refused auto-merge
and routed to explicit authority by the standard's orchestrator. The
risk-sensitive paths remain listed in `.agent/project.yaml`
(`risk.protected_paths`), and `tools/check.sh` remains the protected gate:
no change may weaken, skip, or edit it to make its own diff pass.

---

## Running Locally

Run the same checks the CI workflows run:

```bash
bash tools/check.sh
```

This runs, in order: the full test suite (`python -m unittest discover -s
tests -v`), all three quality tools at the same intensities `code-quality.yml`
used, and shell syntax checks on `tools/fix_*.sh` and `tools/run_fixes.sh`
-- printing PASS/FAIL per step and exiting non-zero if
anything failed. Individual commands, if you want to run just one:

```bash
# Tests
python -m unittest discover -s tests -v

# Code quality checks
python tools/code_simplification.py netcheck -i low
python tools/security_review.py . -i high
python tools/documentation_check.py . -i medium

# Fix scripts
bash -n tools/fix_*.sh tools/run_fixes.sh
```

To cut a release without spending Actions minutes:

```bash
bash tools/deploy.sh          # runs tools/check.sh, then builds + smoke-tests the image
```

---

## Workflow Status

View workflow status and logs:
- https://github.com/kgsmith19/network-checker/actions

Each workflow shows:
- ✓ Passed (green)
- ✗ Failed (red)
- ⊘ Skipped (gray)

Click any workflow to see detailed logs.

---

## Adjusting Intensity

The quality-tool intensities live in `tools/check.sh` (the ceilings come
from `rules/01-BUDGETS.md`), not in the workflow files -- `code-quality.yml`
just runs that script. Change them there so local runs and CI stay
identical, and remember `tools/check.sh` is the protected gate: intensity
changes ship in their own reviewed PR, never in the PR they would gate.

`-i low` (lenient, only major issues) / `-i medium` (balanced) / `-i high` (strict)

---

## Troubleshooting

### Anything Failing
```bash
bash tools/check.sh
```

### Tests Failing
```bash
python -m unittest discover -s tests -v
```

### Code Quality Issues
```bash
python tools/code_simplification.py netcheck -i low -v
python tools/security_review.py . -i high -v
python tools/documentation_check.py . -i medium -v
```

### Fix script issues
```bash
bash -n tools/fix_*.sh tools/run_fixes.sh
bash tools/run_fixes.sh --dry-run
```
