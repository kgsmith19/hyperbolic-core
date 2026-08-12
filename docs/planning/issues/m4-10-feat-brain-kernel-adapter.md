Title: FEAT(brain): harness adapters with kernel subprocess execution
Type: FEAT
Component: The Brain
Milestone: M4 The Brain
Depends on: m4-09-feat-brain-task-contract.md, m4-07-feat-guards-harness-registration.md
Blocks: m4-11-feat-brain-verification-runner.md, m4-17-feat-brain-observability-cost.md

## Problem
The Brain must execute Claude Code tasks without re-implementing bounded runs; the binding reuse decision is the ACC kernel as a subprocess, one contract in, one ledger record out (07-brain-architecture.md sections 7.1 and 7.4). The adapter interface is frozen in 07 section 7.4.

## Scope
In scope:
- HarnessAdapter interface exactly per 07 section 7.4; claude-code adapter spawning the kernel with env-scoped ACC_ROOT/ACC_POLICY/ACC_VAULT
- kernel.contract.v1 versioning of the kernel input (07 gate question 3)
- One git worktree per task under /workspaces, created before dispatch, removed after result persistence
- Codex and Gemini stub adapters whose probe returns not-available
- Deterministic routing rule and the transport/logic/timeout/orphaned failure taxonomy with lane-discipline retries
- Generated settings for every dispatch include the Guards block per the m4-07 contract
Out of scope:
- Brain-side verification (m4-11); real Codex/Gemini invocation flags (verified at their own implementation issues per 07 gate question 2)

## Acceptance criteria
When a task dispatches, the kernel shall receive a versioned contract and the run shall produce a parsed ledger record normalized into brain.result.v1.
Concurrent tasks shall never share a worktree, and worktrees shall be removed after result persistence.
When the selected harness fails twice consecutively with transport classification, the task shall requeue against the first fallback whose probe passes, and the harness shall never change silently mid-task.
Logic failures (non-zero verdicts) shall never auto-retry.

## Verification
Kernel fixture run through the adapter; assert ledger ref recorded and result parsed
Worktree lifecycle integration test (two concurrent fixture tasks; distinct paths; both removed)
Fake-adapter test: two transport failures reroute; journal records the requeue decision
Fake-adapter test: logic failure ends the task failed with zero retries

## Estimated LOC delta
Added: 700  Deleted: 0  Net: +700

## Risk
Medium; couples Brain releases to kernel contract stability, accepted and versioned (07 gate question 3).
