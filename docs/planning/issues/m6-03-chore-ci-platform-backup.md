Title: CHORE(ci): platform-project backup workflow
Type: CHORE
Component: hyperbolic-core
Milestone: M6 Hardening
Depends on: m1-05-chore-ci-platform-migrations-workflow.md
Blocks: none

## Problem
Platform-project data has no backup pipeline, and destructive platform migrations are forbidden by rule until one exists (10-cicd-deployment.md sections 8.4 and 9). The age-encrypted backup pattern is proven in the lifeos standalone pipeline.

## Scope
In scope:
- Root workflow extending the age-encrypted backup pattern to the platform Supabase project, scheduled plus dispatchable
- Runbook rows: restore drill steps and the destructive-migration precondition (fresh backup run id recorded in the PR)
Out of scope:
- LifeOS backups (standalone repo, unchanged); Brain state backups (volume snapshot noted in the runbook, extended per ADR-04 when the Brain ships data worth drilling)

## Acceptance criteria
When the workflow is dispatched, it shall produce an age-encrypted artifact of the platform project's schemas.
The runbook shall document the restore drill, and one drill shall be executed and recorded.
The destructive-migration rule shall reference this workflow: a destructive platform migration PR without a fresh backup run id shall be refused by the documented rule.

## Verification
gh workflow run of the backup; artifact listed on the run, age header verified
Restore drill executed against a scratch database; row counts recorded in the runbook
Rule text present in the runbook and referenced from the migrations validation docs

## Estimated LOC delta
Added: 90  Deleted: 0  Net: +90

## Risk
Low; copies a proven encrypted-backup pattern to a second target.
