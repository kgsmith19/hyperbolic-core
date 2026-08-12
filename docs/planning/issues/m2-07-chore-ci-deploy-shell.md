Title: CHORE(ci): deploy.yml with the Shell unit and migration gating
Type: CHORE
Component: hyperbolic-core
Milestone: M2 Shell and auth
Depends on: m2-04-feat-shell-serve-routes.md, m1-05-chore-ci-platform-migrations-workflow.md
Blocks: m3-06-feat-intake-submit-api.md, m4-21-chore-ci-deploy-services.md

## Problem
SH-5 requires the Shell to build and deploy with one command; no deploy pipeline exists in this repo. 10-cicd-deployment.md sections 2 and 2.2 specify deploy.yml: a changes job, migrate-platform gating, and the Shell static unit with versioned dirs for rollback.

## Scope
In scope:
- .github/workflows/deploy.yml: changes job (per-unit path booleans), migrate-platform call to platform-migrations.yml, build-shell and deploy-shell jobs per 10 section 2.2 (Infisical OIDC, tailnet join, dist-<sha> dirs, current symlink, prune to 3, health curl), DEPLOY_ENABLED gate, per-unit concurrency groups
Out of scope:
- Brain and Handler A units (m4-21); LifeOS pipeline (standalone repo, untouched)

## Acceptance criteria
When the deploy command runs, it shall exit 0 and the deployed Shell health route shall return 200 (SH-5).
When migration paths changed in the same push, deploy-shell shall wait for migrate-platform success.
Rollback by repointing the current symlink to the prior dist-<sha> shall complete in under 5 minutes with no rebuild.
While DEPLOY_ENABLED is not true, no deploy job shall run.

## Verification
gh workflow run deploy.yml && curl -s -o /dev/null -w '%{http_code}' https://<origin>/healthz returns 200
Workflow run graph shows deploy-shell needs migrate-platform (success or skipped)
ssh deploy@host 'ln -sfn dist-<prior-sha> shell/current' then curl asserts the prior asset hash; timed under 5 minutes
Dispatch with DEPLOY_ENABLED unset; jobs skip

## Estimated LOC delta
Added: 180  Deleted: 0  Net: +180

## Risk
Medium; first monorepo deploy pipeline, mitigated by copying the proven lifeos job shapes.
