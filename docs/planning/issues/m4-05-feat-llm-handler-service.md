Title: FEAT(llm-handler): Handler A service with call logging
Type: FEAT
Component: hyperbolic-core
Milestone: M4 The Brain
Depends on: m4-01-feat-llm-core.md, m4-02-feat-llm-alt-drivers.md, m3-02-feat-toolbelt-registry-extension.md
Blocks: m4-06-feat-intake-optimize.md, m4-21-chore-ci-deploy-services.md, m6-02-feat-shell-cost-dashboard.md

## Problem
General-purpose consumers need LLM access without holding provider keys, and one shared handler process holding the Brain key is forbidden by ADR-05; Handler A is the general-keys deployment of the shared library (08-llm-handlers.md section 3, forced decisions 5 and 7).

## Scope
In scope:
- services/llm-handler with the route surface of 08 section 5 (/v1/complete, /v1/stream, /v1/count, /healthz), ADR-03 auth, per-caller concurrency cap
- core.llm_call migration pair plus its 180-day retention per 08 section 6
- Headless tool.json manifest and generated registration so the Shell discovers and health-checks it (08 forced decision 7)
Out of scope:
- Deploy jobs (m4-21); the Brain's in-process use of the library (m4-08 onward); LifeOS migration onto the handler (deferred, 08 section 8)

## Acceptance criteria
If a request reaches /v1/* without a valid operator session JWT or scoped agent token, then the service shall respond 401.
Every completed call shall insert exactly one core.llm_call row carrying caller_app and purpose.
Handler overhead shall be at most 30 ms p95 over a direct provider call, and /v1/count shall answer within 50 ms p95.
The service shall have no configuration key for the Brain key, and its process context shall be unable to read the /brain/ secrets path.

## Verification
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8200/v1/complete returns 401
Integration test: one fixture call, then psql select count(*) from core.llm_call where caller_app='fixture'; returns 1
Overhead benchmark in the service test suite (probe vs direct, 50 calls)
grep -rn "BRAIN" services/llm-handler --include='*.ts' returns zero key-name hits; ADR-05 isolation check run in the handler context exits non-zero on /brain/

## Estimated LOC delta
Added: 760  Deleted: 0  Net: +760

## Risk
Medium; takes the fourth and final deployable-unit slot, displacing the Caddy reserve (recorded in 08 section 3).
