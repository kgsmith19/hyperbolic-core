Title: FEAT(brain): task contract v1, result schema, and journaled run rows
Type: FEAT
Component: The Brain
Milestone: M4 The Brain
Depends on: m4-08-feat-brain-daemon-state.md, m4-04-feat-llm-prompt-client.md
Blocks: m4-10-feat-brain-kernel-adapter.md, m4-12-feat-brain-autonomy-approvals.md, m4-13-feat-brain-cli.md

## Problem
BR-1 requires every submitted task to become a schema-validated contract with a run row recorded before the harness starts. The normative field list for brain.task.v1 and brain.result.v1, plus the exact completion definition, is 07-brain-architecture.md section 7.5.

## Scope
In scope:
- JSON Schema files for brain.task.v1 and brain.result.v1 per 07 section 7.5, validation at plan time and dispatch time
- Planner output validation (schema-validated task DAG)
- Prompt references resolved as pinned name at version through getPrompt (prompt_org_refs)
- Dry-run rendering of contracts; run and task rows journaled before any side effect
Out of scope:
- Execution (m4-10), verification (m4-11), approvals (m4-12)

## Acceptance criteria
When the operator submits a task through any Brain surface, the Brain shall issue a contract to exactly one harness and record a run row before the harness starts (BR-1).
When a dry run is requested, the system shall print the validated contracts and exit 0 with zero dispatch.
If a contract fails schema validation, then the run shall be refused with exit code 2 and no run row in a dispatchable state.
A deliverable branch matching a default branch name shall fail validation.

## Verification
brain run --dry-run "<objective>" prints contracts; exit 0; DB query for the printed run id returns the journaled row
sqlite3 /data/brain.db "select count(*) from run where id='<id>'" returns 1 before any invocation row exists (integration test ordering assertion)
Invalid-contract fixture: brain run exits 2
Schema test rejecting deliverable.branch values main and master

## Estimated LOC delta
Added: 400  Deleted: 0  Net: +400

## Risk
Low; schemas are the keystone but purely declarative plus validation wiring.
