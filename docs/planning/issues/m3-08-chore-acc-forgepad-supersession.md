Title: CHORE(acc): migrate Forgepad ideas to Idea Intake and delete Forgepad
Type: CHORE
Component: Agentic Command Center
Milestone: M3 Toolbelt platform and Idea Intake
Depends on: m3-05-feat-intake-schema.md
Blocks: none

## Problem
Forgepad is half-shipped: a complete tested idea store with zero routes, an unreachable HTML page, and a test file CI never runs (D-01, 02-health-audit.md). ACC-4 requires supersession by Idea Intake with any live ideas migrated; the field mapping and CLI spec are 05-h-idea-intake.md section 10 and 05-b-acc.md section 7.

## Scope
In scope:
- One-shot migration CLI (migrate-forgepad.mjs) per the 05-h section 10 mapping, idempotent on the provenance ref, dry-run counts, non-zero exit on any unparseable file, clean zero-file handling
- Operator run with recorded counts; rejected ideas skipped with a printed audit (05-h gate question 2 default)
- Deletion of forgepad/store.mjs, forgepad/store.test.mjs, gui/forgepad.html, and surviving doc mentions
- Follow-up removal of the one-shot CLI once counts are confirmed (05-h section 13)
Out of scope:
- Any intake schema or UI change

## Acceptance criteria
When the repository is grepped for forgepad after migration, code and HTML hits shall be zero (ACC-4a).
When the migration has run, the intake row count carrying the forgepad provenance ref shall equal the source file count minus rejected (ACC-4b).
When the tool runs twice, the second run shall insert zero rows.
The ACC suite and covgate shall stay green after the deletions (ACC-1).

## Verification
grep -rn forgepad apps/agentic-command-center --include='*.mjs' --include='*.html' returns zero hits
Dry-run count recorded, then psql: select count(*) from intake.idea where source like 'forgepad:%'; matches
Second invocation log shows 0 inserted
cd apps/agentic-command-center && npm test && npm run covgate

## Estimated LOC delta
Added: 120  Deleted: 611  Net: -491

## Risk
Low; migration is count-independent and idempotent; deletions remove an orphaned subsystem.
