Title: FEAT(brain): CLI verbs and exit-code contract
Type: FEAT
Component: The Brain
Milestone: M4 The Brain
Depends on: m4-08-feat-brain-daemon-state.md, m4-09-feat-brain-task-contract.md, m4-12-feat-brain-autonomy-approvals.md
Blocks: none

## Problem
BR-1 and BR-6 need an operator surface; the full verb, flag, exit-code, and stdout contract is the CLI table in 07-brain-architecture.md section 7.8.

## Scope
In scope:
- brain run/status/tasks/approve/reject/cancel/resume/logs/cost/refresh-context/config verbs with the exact flags and exit codes of the 07 section 7.8 table
- Global behavior: --json emits one JSON document with human text on stderr; no interactive prompts when stdin is not a TTY; exit 4 means parked awaiting approval, never an error
Out of scope:
- brain eval verbs (m4-19); the HTTP API (m4-14)

## Acceptance criteria
Every verb shall honor the 07 section 7.8 exit-code table (0 ok, 1 error, 2 policy-refused, 3 not-found, 4 awaiting-approval).
When --json is passed, stdout shall parse as a single JSON document.
While stdin is not a TTY, no verb shall prompt interactively.
brain run --dry-run shall print contracts and exit 0 (BR-1 surface).

## Verification
node --test services/brain/tests/cli.test.mjs (exit-code matrix per verb against a fixture daemon)
brain status --json | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' exits 0
echo | brain approve <id>; completes or fails without prompting (asserted in test)
brain run --dry-run "<objective>"; echo $? prints 0

## Estimated LOC delta
Added: 900  Deleted: 0  Net: +900

## Risk
Low; thin verbs over the service layer; may land as two PRs (read verbs, then mutating verbs) within this issue.
