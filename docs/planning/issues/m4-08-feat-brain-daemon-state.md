Title: FEAT(brain): daemon, state store, scheduler, and brain-ci
Type: FEAT
Component: The Brain
Milestone: M4 The Brain
Depends on: m1-01-chore-platform-workspace-setup.md, m1-11-fix-acc-defect-sweep.md
Blocks: m4-09-feat-brain-task-contract.md, m4-13-feat-brain-cli.md, m4-14-feat-brain-api-sse.md, m4-18-feat-brain-security-redaction.md, m4-21-chore-ci-deploy-services.md

## Problem
The Brain does not exist in any repository (00-canonical-names.md). Its runtime model, state store, crash recovery, and scheduler are specified in 07-brain-architecture.md sections 7.3 and 7.6; BR-6 requires one-command start with health reporting.

## Scope
In scope:
- services/brain daemon (Node 22, TypeScript): startup load-open-reconcile-serve, SIGTERM drain with 120 s grace and killTree, /healthz per 07 section 7.3
- SQLite WAL state store with the 07 section 7.6 tables (run, task, task_edge, invocation, approval, cost, eval_case, eval_result)
- DAG scheduler dispatching tasks whose parents reached terminal success, N=2 concurrency cap
- Crash recovery: journal-before-side-effect transitions; boot probe re-attaches, resumes, or marks interrupted
- .github/workflows/brain-ci.yml per 10 section 1.3
Out of scope:
- Contract schemas (m4-09), adapters (m4-10), interfaces (m4-13, m4-14), journal streaming (m4-14)

## Acceptance criteria
The Brain daemon shall start with one command and brain status shall exit 0 reporting health (BR-6, local form).
When the daemon is killed mid-run and restarted, every previously running task shall be re-attached, resumed, or marked interrupted; none shall remain running.
Concurrent harness dispatch shall never exceed 2 (unit test with fake adapters).
When a PR touches services/brain/**, the Brain PR Gate shall run and report.

## Verification
<start command from 07 section 7.3> && brain status; echo $? prints 0
Kill-and-restart integration test asserting no task remains in running
node --test services/brain/tests/scheduler.test.mjs (concurrency cap case)
gh pr checks on a fixture PR touching services/brain shows Brain PR Gate

## Estimated LOC delta
Added: 870  Deleted: 0  Net: +870

## Risk
Medium; the reconcile path is the correctness keystone for every later Brain issue.
