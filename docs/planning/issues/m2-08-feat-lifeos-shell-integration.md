Title: FEAT(lifeos): zone base path, shared chrome, and Shell-session login migration
Type: FEAT
Component: LifeOS
Milestone: M2 Shell and auth
Depends on: m2-03-feat-shell-login-gate.md, m2-01-feat-ui-chrome-palette.md
Blocks: m4-20-feat-brain-lifeos-forwarding.md, m5-07-feat-lifeos-review-surface.md, m5-08-feat-lifeos-tomorrow-planner.md

## Problem
LifeOS runs its own login page against its own Supabase project, one of the three disjoint auth flows ADR-03 retires (05-e-lifeos.md section 4). LO-2 requires the Shell session; SH-1b requires the shared chrome in the LifeOS zone; the /life/* prefix requires base-path awareness (05-a section 4).

## Scope
In scope:
- Base-path config: Vite base /life/, router basename, FastAPI root_path (05-a section 4 mechanics)
- Chrome adoption from packages/ui (contract C-3)
- Session from packages/platform-client; deletion of Login.tsx, Login.test.tsx, and the login route
- Env re-point of LIFEOS_SUPABASE_URL and LIFEOS_OWNER_USER_ID to the platform project; frontend VITE_ vars re-pointed; agent and MCP tokens re-minted (05-e section 4 steps 1-7, executed as one deploy train)
- Break-glass documentation row (LIFEOS_AUTH_MODE=disabled, localhost only)
Out of scope:
- Any other standalone-repo CI/CD change (05-e section 5); the two V1 features (m5-07, m5-08)

## Acceptance criteria
When the operator authenticates at the Shell, LifeOS routes shall render data with no second login (LO-2a).
The LifeOS frontend shall contain no local sign-in call (LO-2b).
If a request reaches the backend with a JWT signed by the old project's keys, then the backend shall reject it with 401 (LO-2c).
If a request presents a platform JWT whose subject is not the owner UUID, then the backend shall reject it with 401 (LO-2d).
While LIFEOS_AUTH_MODE=disabled is set, the backend shall serve localhost requests and log the disabled mode on startup (LO-2e).
When /life/ renders, the zone shall show the shared chrome with data-testid platform-nav (SH-1b).
Existing standalone-repo gates shall stay green (LO-1).

## Verification
cd apps/shell && npx playwright test e2e/single-session.spec.ts (LifeOS case)
grep -rn signInWithPassword apps/lifeos/frontend/src --include='*.ts*' returns zero hits outside packages/platform-client usage
curl -s -o /dev/null -w '%{http_code}' with a stale-issuer token against /life/api/types returns 401
pytest tests/api/test_auth.py in the standalone repo (platform-issuer and auth-mode fixtures)
npx playwright test e2e/chrome.spec.ts (the /life/ case)
Standalone PR Gate run link recorded in TEST_LEDGER.md

## Estimated LOC delta
Added: 180  Deleted: 180  Net: +0

## Risk
High for the deploy window; a partial re-point strands the frontend against the wrong issuer, so steps execute as one train with the smoke flow after (05-e section 4 risks).
