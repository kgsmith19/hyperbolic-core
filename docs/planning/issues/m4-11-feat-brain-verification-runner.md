Title: FEAT(brain): independent verification runner and verdict persistence
Type: FEAT
Component: The Brain
Milestone: M4 The Brain
Depends on: m4-10-feat-brain-kernel-adapter.md
Blocks: m4-19-feat-brain-eval-harness.md

## Problem
BR-2 requires failing verification to be recorded, never silently dropped, and 07-brain-architecture.md fixes the principle that verification is never delegated to the harness that did the work (07 sections 7.1 and 7.5 completion definition).

## Scope
In scope:
- Brain-executed acceptance verify commands in the task worktree after harness exit, per contract fields (command, cwd, expect_exit, timeout_s)
- Verdict rows (id, pass, exit, output tail) persisted per task; the exact three-condition completed definition of 07 section 7.5
Out of scope:
- Eval harness (m4-19); deliverable push mechanics (adapter-owned)

## Acceptance criteria
When a run's verify command is the literal command false, the run shall be recorded failed and shall appear in status output (BR-2).
Every verdict shall persist id, pass, exit code, and output tail keyed to its task.
A task shall be recorded completed only when every verify command returns its expect_exit, the worktree is clean or committed per deliverable, and the session terminated without orphaned classification.
A verify command exceeding timeout_s shall terminate and record a failed verdict.

## Verification
Seed a task whose verify command is false; sqlite3 query returns status failed; brain status shows it
sqlite3 verdict-row query for a fixture run returns all four fields non-null
Completion-matrix unit test over the three conditions
Timeout fixture case records a failed verdict with the timeout noted

## Estimated LOC delta
Added: 300  Deleted: 0  Net: +300

## Risk
Low; bounded child processes with recorded output, no new privilege.
