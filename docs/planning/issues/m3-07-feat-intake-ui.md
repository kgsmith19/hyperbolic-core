Title: FEAT(intake): /ideas list, editor, and submit flow in the Shell
Type: FEAT
Component: Idea Intake
Milestone: M3 Toolbelt platform and Idea Intake
Depends on: m3-05-feat-intake-schema.md, m3-06-feat-intake-submit-api.md, m2-02-feat-shell-scaffold.md
Blocks: m3-09-chore-toolbelt-root-client-deletion.md, m4-06-feat-intake-optimize.md

## Problem
Two dead idea surfaces exist (orphaned Forgepad, untested root client) and no live capture surface. The wireframe-level UI spec is 05-h-idea-intake.md section 8; TB-4/II rows require the app live in the Shell at /ideas/*.

## Scope
In scope:
- /ideas list with filter tabs and locked rendering of submitted rows; /ideas/new and /ideas/:id editors with status-dependent action sets; the submit confirmation modal with body preview per 05-h section 8
- packages/ui components only; client-side title filter; no kanban, comments, attachments, or search beyond the spec's simplicity rule
Out of scope:
- Optimize action wiring beyond a disabled placeholder (enabled by m4-06)

## Acceptance criteria
When a submitted idea renders, the page shall be read-only with exactly one action (optimize as new derivative) plus the issue link (II-3 UI layer).
When the draft, promote, and submit flow runs against a scratch repo, the row shall pass draft to idea to submitted with the modal preview shown before any network call.
The list query shall render within 300 ms p95 warm and an editor save within 400 ms p95.
The pages shall use packages/ui primitives and tokens only (09 section 8 grep rule).

## Verification
cd apps/shell && npx playwright test e2e/ideas.spec.ts (locked-rendering, flow, and modal cases)
Perf cases in the same spec (50-call p95 list; save timing)
grep -rn "oklch(\|#[0-9a-fA-F]\{3,8\}\b" apps/shell/src/pages/ideas --include='*.tsx' --include='*.css' returns zero hits

## Estimated LOC delta
Added: 650  Deleted: 0  Net: +650

## Risk
Low; one-query list and one-row editor over structurally guarded data.
