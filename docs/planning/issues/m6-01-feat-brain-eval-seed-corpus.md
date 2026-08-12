Title: FEAT(brain): eval seed corpus and nightly run
Type: FEAT
Component: The Brain
Milestone: M6 Hardening
Depends on: m4-19-feat-brain-eval-harness.md
Blocks: none

## Problem
The eval harness exists without cases; 07-brain-architecture.md section 7.11 mandates a minimum 5-case seed corpus before V1 ships, plus a nightly full run.

## Scope
In scope:
- The 5 named seed cases: plan-only, single-task success, verify-failure, approval-park, transport-retry
- Nightly scheduled full corpus run
Out of scope:
- Rubric grading (deferred behind its interface); additional cases beyond the seed set (accrue via the capture process rule)

## Acceptance criteria
When brain eval run executes, all 5 seed cases shall pass and the command shall exit 0.
A deliberately regressed fixture shall make the gate fail (exit 1) on the corpus step.
A nightly workflow shall be scheduled and its latest run recorded.

## Verification
brain eval run; echo $? prints 0 with 5 cases listed
Regression fixture branch; Brain PR Gate fails on the eval step
gh workflow view of the nightly schedule shows cron and last run

## Estimated LOC delta
Added: 300  Deleted: 0  Net: +300

## Risk
Low; cases are frozen contracts over already-tested behavior.
