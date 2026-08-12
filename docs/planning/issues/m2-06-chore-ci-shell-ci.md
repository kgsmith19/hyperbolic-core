Title: CHORE(ci): shell-ci.yml PR gate
Type: CHORE
Component: hyperbolic-core
Milestone: M2 Shell and auth
Depends on: m2-02-feat-shell-scaffold.md
Blocks: none

## Problem
No gate verifies apps/shell or packages/*; a shared-package change can break the Shell unseen. 10-cicd-deployment.md section 1.2 specifies the job.

## Scope
In scope:
- .github/workflows/shell-ci.yml per 10 section 1.2: workspace npm ci, lint, tsc -b, vitest for apps/shell and packages/platform-client, packages/ui, packages/llm, the 05-a Playwright suites with cached Chromium, production build, failure evidence upload
Out of scope:
- deploy.yml (m2-07), brain-ci (m4-08)

## Acceptance criteria
When a PR touches apps/shell/** or packages/**, the Shell PR Gate check shall run and report.
The gate shall execute every 05-a e2e suite named in 10 section 1.2.
The job shall complete within the 8 minute budget with a timeout-minutes ceiling of roughly twice the budget.

## Verification
gh pr checks on a fixture PR touching packages/ui shows Shell PR Gate
Workflow log lists chrome, auth-gate, single-session, and idp-down spec runs
gh run view shows wall clock under 8 minutes; grep timeout-minutes .github/workflows/shell-ci.yml

## Estimated LOC delta
Added: 95  Deleted: 0  Net: +95

## Risk
Low; mirrors the two existing gates' patterns.
