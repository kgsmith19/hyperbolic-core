Title: FEAT(acc): loopback API session credential
Type: FEAT
Component: Agentic Command Center
Milestone: M2 Shell and auth
Depends on: none
Blocks: none

## Problem
The ACC loopback API has no authentication; any local process can drive it (SEC-04, 02-health-audit.md). ACC-5 requires the loopback API to refuse requests lacking the session credential; the chosen mechanism is the shared-secret header contract of 05-b-acc.md section 4.

## Scope
In scope:
- Token file, X-ACC-Token header requirement on every /api/* request, constant-time compare, 401 error envelope, fragment-URL browser bootstrap, ACC_GUI_TOKEN_FILE env seam, rotation by file deletion, per 05-b section 4
- gui/README.md contract update
Out of scope:
- CORS and Private Network Access grants (ship only with UI absorption, post-V1 per 05-b section 6)
- Platform JWT verification (rejected for V1 with rationale in 05-b section 4)

## Acceptance criteria
If a request reaches any /api/* route without X-ACC-Token, then the server shall respond 401 within 50 ms (ACC-5a).
When a request presents the token from the token file, the server shall serve the route normally (ACC-5b).
When the server starts with no token file present, the system shall create one with owner-only permissions before accepting requests (ACC-5c).
Token check overhead shall stay under 1 ms added p95 per authorized request.

## Verification
curl -s -o /dev/null -w '%{http_code} %{time_total}\n' http://127.0.0.1:43117/api/guards/status returns 401 under 0.05
curl -s -o /dev/null -w '%{http_code}' -H "X-ACC-Token: $(cat $ACC_ROOT/gui-token)" http://127.0.0.1:43117/api/guards/status returns 200
node --test apps/agentic-command-center/gui/server.test.mjs (token-file creation and mode case under temp ACC_ROOT)
Timed loop comparing authorized request latency before and after; delta under 1 ms p95

## Estimated LOC delta
Added: 140  Deleted: 0  Net: +140

## Risk
Low; defense-in-depth checks retained, token cached in memory.
