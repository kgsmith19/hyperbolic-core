Title: CHORE(ci): platform migrations workflow, validation lint, and ledger baseline
Type: CHORE
Component: Toolbelt
Milestone: M1 Platform foundations
Depends on: none
Blocks: m1-06-feat-db-platform-bootstrap.md, m2-07-chore-ci-deploy-shell.md, m6-03-chore-ci-platform-backup.md

## Problem
Platform-project migrations are applied by hand via the Supabase API (06-supabase-schema.md section 7.1), and two committed migrations share version key 20260808120000, which collides in the CLI's version-keyed ledger (06 section 7.2, the migration rename trap). 10-cicd-deployment.md section 5 defines the workflow interface.

## Scope
In scope:
- Root workflow platform-migrations.yml (workflow_call + workflow_dispatch) applying per-directory migrations in the fixed order of 06 section 7.2 via supabase db push, authenticated by a GitHub OIDC Infisical machine identity scoped to /platform/
- PR-side validation: every up has a paired _down.sql, no file creates the reserved brain schema, and the RLS policy lint (bare platform.owner() calls outside a scalar subquery fail)
- One-time ledger baseline of the 18 applied pairs, preceded by a supabase db diff parity check (06 gate question 5)
- Rename 20260808120000_prompt_create_render_function.sql to 20260808130000 (content untouched)
- project.yaml apply_migration line repointed at the workflow
Out of scope:
- Any new migration content (m1-06 onward)
- The deploy.yml orchestration that calls this workflow (m2-07)

## Acceptance criteria
When a PR adds an up migration without a paired _down.sql, the PR Gate shall fail.
When a migration file contains a statement creating the brain schema, validation shall fail.
When the workflow is dispatched with zero pending migrations after the baseline, it shall exit 0 without re-executing any of the 18 baseline pairs.
If the one-time live diff against the platform project is non-empty, the baseline run shall fail and attach the diff as an artifact.
The repository shall contain no two platform migration files sharing a version key.

## Verification
Push a fixture branch with an unpaired up migration; the Toolbelt PR Gate check fails
Push a fixture branch containing "create schema brain"; validation fails
gh workflow run platform-migrations.yml, then re-run; second run exits 0 with zero applied statements in the log
ls apps/toolbelt/**/supabase/migrations | sed 's/_.*//' | sort | uniq -d returns empty

## Estimated LOC delta
Added: 150  Deleted: 2  Net: +148

## Risk
Medium; ledger baseline against the live project is one-time and must follow the db diff parity check.
