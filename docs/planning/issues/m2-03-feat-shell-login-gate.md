Title: FEAT(shell): login gate, single session, and fail-closed auth paths
Type: FEAT
Component: Shell
Milestone: M2 Shell and auth
Depends on: m2-02-feat-shell-scaffold.md, m1-07-chore-platform-idp-owner-setup.md
Blocks: m2-08-feat-lifeos-shell-integration.md, m5-01-feat-po-shell-contract.md

## Problem
SH-2 and SH-3 require exactly one login surface with session propagation to every composed app, and SH-4/SH-6 require fail-closed behavior on every unauthenticated or IdP-down path (03-v1-definition.md; 05-a sections 6 and 12).

## Scope
In scope:
- Shell login gate on every route prefix, deep-link return after login (SH-2b)
- Session propagation via packages/platform-client to all Shell-served surfaces
- E2E suites: auth-gate, single-session, idp-down, and the SH-4 curl checks
Out of scope:
- LifeOS zone wiring (m2-08); server-side 401 behavior of individual APIs (owned by each API's issue)

## Acceptance criteria
When an unauthenticated browser requests any prefix in the 05-a section 4 route map, the Shell shall present the login flow and shall render zero data nodes (SH-2a).
When login succeeds from a gated deep link, the Shell shall navigate to the originally requested path (SH-2b).
When the operator authenticates once, one authenticated API call per composed app shall return 200 with no second login (SH-3).
If a request reaches any /api/* upstream without a valid platform JWT, then that upstream shall respond 401 within 50 ms excluding network RTT (SH-4).
While the IdP is unreachable, no cached page shall issue an authenticated API call with an expired token (SH-6).

## Verification
cd apps/shell && npx playwright test e2e/auth-gate.spec.ts
npx playwright test e2e/single-session.spec.ts
curl -s -o /dev/null -w '%{http_code} %{time_total}\n' https://<origin>/life/api/entities/x (repeat per API base; expect 401 under 0.05 plus RTT)
npx playwright test e2e/idp-down.spec.ts

## Estimated LOC delta
Added: 350  Deleted: 0  Net: +350

## Risk
Medium; the gate is the single auth chokepoint for every zone, so its e2e suite is the SH regression net.
