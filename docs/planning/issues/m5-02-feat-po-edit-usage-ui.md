Title: FEAT(prompt-organizer): body edit, rename refusal, and usage surfacing
Type: FEAT
Component: Prompt Organizer
Milestone: M5 Component upgrades
Depends on: m5-01-feat-po-shell-contract.md
Blocks: none

## Problem
The update grant exists but no edit UI does (02-health-audit.md gap register); a system prompt store whose only body-change path is restore gymnastics fails its consumers. 05-d section 10 decides body edit, section 5 sets the rename rule, and section 9 ships usage telemetry (rank 1) and the token estimate (rank 2).

## Scope
In scope:
- Body-edit UI; every save versioned by the existing trigger
- Title edits refused in the UI for namespaced prompts (create-new-and-archive-old is the rename path); permitted for legacy personal prompts
- Usage count badge from the usage table; chars/4 token estimate labeled as an estimate
Out of scope:
- Diff view, linting, composition, environment scoping, A/B, eval links (all deferred per 05-d section 9)

## Acceptance criteria
When a body is edited and saved, a new version row shall appear with the incremented max version_no and history unchanged.
When a title edit is attempted on a prompt matching the namespace grammar, the UI shall refuse it.
The list surface shall show a per-prompt usage count matching the usage table.
The rendered preview shall show a token estimate visibly labeled as an estimate.

## Verification
node --test apps/toolbelt/apps/prompt-organizer/tests/edit.test.mjs (version increment case)
E2E rename-refusal case for a namespaced fixture and an allowed legacy fixture
Badge count asserted equal to a seeded usage count in the e2e suite
Preview label assertion in the same suite

## Estimated LOC delta
Added: 210  Deleted: 0  Net: +210

## Risk
Low; edit is safe by construction because the trigger versions every body update.
