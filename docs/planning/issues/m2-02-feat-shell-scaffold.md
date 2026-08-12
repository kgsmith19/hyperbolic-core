Title: FEAT(shell): scaffold, route groups, home, settings, and ACC status card
Type: FEAT
Component: Shell
Milestone: M2 Shell and auth
Depends on: m2-01-feat-ui-chrome-palette.md, m1-02-feat-platform-client-session.md
Blocks: m2-03-feat-shell-login-gate.md, m2-04-feat-shell-serve-routes.md, m2-06-chore-ci-shell-ci.md, m3-04-feat-shell-tools-discovery.md, m3-07-feat-intake-ui.md, m4-16-feat-shell-brain-surface.md

## Problem
No Shell exists; the repo root contains zero application code (05-a section 1). SH-1 requires one front door composing every surface under the route map of 05-a section 4.

## Scope
In scope:
- apps/shell app (React 19 + Vite 8 + Tailwind 4) with route groups /, /acc, /tools, /prompts, /ideas and placeholder pages where owning issues land content
- Home page: launcher cards, health summary
- Settings page per 05-a section 8 (theme, session card, unit health rows, version info, break-glass runbook link)
- /acc status card reading GET /api/process/status with the documented degrade to "ACC unreachable" (05-b section 5)
Out of scope:
- Login gate (m2-03), notifications (m2-05), registry-driven tools list (m3-04), Idea Intake pages (m3-07), Brain surface (m4-16)

## Acceptance criteria
When an authenticated operator requests /, /acc, /tools, /prompts, or /ideas, the Shell shall render the shared chrome (SH-1a).
The settings page shall render one health row per deployable unit calling its health route.
When the ACC loopback API is unreachable, the /acc card shall render the unreachable state and no error toast.
The production build shall stay within the 250 KB gz initial JS budget (09 section 6).

## Verification
cd apps/shell && npx playwright test e2e/chrome.spec.ts
Settings spec asserting one health row per unit
/acc card degrade case in the shell unit tests (mocked fetch failure)
node packages/ui/test/size-check.mjs against apps/shell/dist

## Estimated LOC delta
Added: 900  Deleted: 0  Net: +900

## Risk
Low; greenfield SPA on the stack both existing React apps already use.
