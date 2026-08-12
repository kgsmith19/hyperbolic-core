Title: FEAT(toolbelt): scaffold CLI for the 3-step tool lifecycle
Type: FEAT
Component: Toolbelt
Milestone: M3 Toolbelt platform and Idea Intake
Depends on: m3-01-feat-toolbelt-manifest-schema.md, m3-02-feat-toolbelt-registry-extension.md, m1-01-chore-platform-workspace-setup.md
Blocks: m3-05-feat-intake-schema.md

## Problem
Adding a tool today is roughly 8 manual steps touching 3+ files outside the new app plus out-of-band SQL (02-health-audit.md section 5 item 4). TB-3 caps the lifecycle at 3 steps with no edits outside the new tool directory except generated registration; the CLI usage spec is 05-c section 5.1.

## Scope
In scope:
- packages/toolbelt-cli implementing tool:new per the 05-c section 5.1 usage spec, generated layout, exit codes, and no-partial-writes rule
- Root tool:new script wiring
Out of scope:
- Applying migrations (step 2/3 ride supabase db push via m1-05's workflow)

## Acceptance criteria
When the documented 3 steps run for a scratch tool, git status shall show changes only under the new tool directory plus the generated registration files (TB-3).
If the id is taken in core.app or on disk, or the schema collides across manifests, then the CLI shall exit 2 with no partial writes.
When --dry-run is passed, the CLI shall print the plan and write nothing.
A scaffold invocation shall complete within 10 seconds.

## Verification
npm run tool:new -- --id scratch-tool --name "Scratch" --kind ui --route /scratch; git status --porcelain shows only apps/toolbelt/apps/scratch-tool/ and apps/toolbelt/supabase/migrations/*register_scratch-tool*
Collision fixture case exits 2; git status clean
npm run tool:new -- --dry-run ...; git status clean
Timed invocation under 10 s in the CLI test

## Estimated LOC delta
Added: 350  Deleted: 0  Net: +350

## Risk
Low; generator with validation, no runtime surface.
