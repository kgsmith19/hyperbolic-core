Title: FEAT(intake): LLM optimize flow as derivative-only writes
Type: FEAT
Component: Idea Intake
Milestone: M4 The Brain
Depends on: m4-04-feat-llm-prompt-client.md, m4-05-feat-llm-handler-service.md, m3-07-feat-intake-ui.md
Blocks: none

## Problem
G3 makes the hard rule livable: submitted ideas improve only through new derivative drafts, never mutation (05-h-idea-intake.md section 5). II-4 requires Idea Intake to use the general-purpose handler and never the Brain key.

## Scope
In scope:
- Optimize flow per the 05-h section 5 request/response contract, fetching the named prompt through getPrompt and calling Handler A
- One intake.optimization row appended per call with handler run id and cost
- UI action wiring: apply-in-place for unsubmitted ideas, derivative INSERT for submitted ones
Out of scope:
- Any Brain involvement; optimize history view (05-h gate question 4 default is table-only)

## Acceptance criteria
Idea Intake shall use the general-purpose LLM handler and shall be unable to read the Brain key (II-4).
Optimization of a submitted idea shall create a new derivative row only, leaving the parent byte-identical (II-3b).
Each optimize call shall append exactly one intake.optimization row.
The optimize round trip shall complete within 10 s p95.

## Verification
ADR-05 isolation check run in the Idea Intake process context exits non-zero on /brain/; grep -rn "BRAIN" apps/toolbelt/apps/idea-intake packages/llm --include='*.ts' --include='*.mjs' returns zero key-name hits
E2E: optimize a submitted fixture; select count(*) from intake.idea where parent_idea_id='<fixture>'; returns 1 and the parent xmin is unchanged
select count(*) from intake.optimization where input_idea_id='<fixture>'; returns 1
Timed round trip in the e2e suite

## Estimated LOC delta
Added: 350  Deleted: 0  Net: +350

## Risk
Low; the write path is already structurally guarded; this adds a read-compute-insert loop.
