Title: FEAT(brain): cost accounting, telemetry mirror, and trace joins
Type: FEAT
Component: The Brain
Milestone: M4 The Brain
Depends on: m4-10-feat-brain-kernel-adapter.md
Blocks: m6-02-feat-shell-cost-dashboard.md

## Problem
BR-5 requires every Brain-initiated harness invocation to carry cost and token accounting attributed to its run id, and 07-brain-architecture.md section 7.9 specifies the log schema, the run to task to invocation trace model, and the platform core mirror.

## Scope
In scope:
- Per-invocation token and dollar accounting from stream-json usage plus transcript audit, stored in the Brain cost table
- Run and cost summaries mirrored to the platform core schema through the sanctioned RPC path; in-process LLM calls mirrored to core.llm_call per 08 section 6
- ndjson log schema with ts, level, ids, event, fields; id propagation into kernel env and back through ledger refs
Out of scope:
- Dashboard UI (m6-02); redaction rules (m4-18)

## Acceptance criteria
Every Brain-initiated harness invocation shall have cost and token accounting attributed to its run id, queryable with non-null tokens and dollars (BR-5).
Every journal and log line shall parse as JSON with the 07 section 7.9 required fields.
For a fixture run, one id join key shall connect the Brain journal, kernel ledger, and harness transcript.
Run and cost summaries shall appear in the platform core mirror after run completion.

## Verification
sqlite3 /data/brain.db "select input_tokens, usd_estimate from cost where run_id='<id>'" returns non-null values
Log-schema test parsing every emitted line in a fixture run
Join test resolving run_id across the three stores for the fixture run
psql: select count(*) from core.run where ref='<brain-run-id>'; returns 1

## Estimated LOC delta
Added: 400  Deleted: 0  Net: +400

## Risk
Low; attribution-only accounting following the ACC rates convention.
