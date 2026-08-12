Title: FEAT(brain): autonomy levels and asynchronous approvals
Type: FEAT
Component: The Brain
Milestone: M4 The Brain
Depends on: m4-09-feat-brain-task-contract.md
Blocks: m4-13-feat-brain-cli.md, m4-14-feat-brain-api-sse.md

## Problem
Blast radius must be capped by mechanism: autonomy levels A0-A3, an always-approve list, and approvals that park asynchronously instead of blocking the DAG (07-brain-architecture.md section 7.7, reconciling the operator's no-blocking preference per 13-dissent.md).

## Scope
In scope:
- Autonomy levels A0-A3 with the 07 section 7.7 permission table; A2 default; A3 gated
- Always-approve list: default-branch pushes, remote deletions, repo settings changes, network open, cumulative cost over the per-run budget, non-allowlisted target repos
- Asynchronous parking in awaiting_approval; independent DAG branches continue; TTL expiry to cancelled with journaled rationale; per-run dollar ceiling checked before each dispatch
Out of scope:
- The approval UI card (m4-15/m4-16) and CLI verbs (m4-13); this issue owns state and policy

## Acceptance criteria
When a task with a write deliverable is submitted at autonomy A1, it shall park awaiting approval and shall not dispatch.
If a contract requests a default-branch push at any autonomy level, then it shall park regardless of level.
While one task is parked, independent DAG branches shall continue dispatching.
When an approval TTL expires, the task shall move to cancelled with a journaled rationale.
When the cumulative cost estimate exceeds the per-run ceiling, the next dispatch shall park.

## Verification
node --test services/brain/tests/autonomy.test.mjs (level matrix cases)
Always-approve fixture contract parks at A3
DAG integration test: parked branch plus progressing sibling
Clock-injected TTL test lands cancelled with rationale in the journal
Cost-ceiling fixture parks the next dispatch

## Estimated LOC delta
Added: 400  Deleted: 0  Net: +400

## Risk
Medium; policy correctness here bounds every destructive capability the Brain has.
