Title: FEAT(shell): notification surface and toast stack
Type: FEAT
Component: Shell
Milestone: M2 Shell and auth
Depends on: m2-01-feat-ui-chrome-palette.md
Blocks: m4-16-feat-shell-brain-surface.md

## Problem
Platform contract C-4 requires one notification surface for Shell, zones, and later the Brain's run events (05-a section 7; BR-4 adjacency). Presentation rules are 09-design-system.md section 4.5.

## Scope
In scope:
- NotificationSurface implementation per the 05-a section 7 signatures
- Toast stack (max 3 visible, overflow to bell inbox) and level-to-token mapping per 09 section 4.5
- Cross-zone transport over BroadcastChannel("platform-notifications")
Out of scope:
- Persistence (deliberately session-ephemeral in V1, 05-a gate question 3)
- Brain event production (m4-14, m4-16)

## Acceptance criteria
When publish is called, a toast shall be visible within 100 ms in the same document and within 100 ms in another zone document on the same origin.
Error-level toasts shall persist until dismissed; success and info shall auto-dismiss at 5 s with hover pausing the timer.
At most 3 toasts shall be visible; older entries shall collapse into the bell inbox with an unread count.
Toasts shall never steal focus and shall announce via a polite live region.

## Verification
cd apps/shell && npx playwright test e2e/notifications.spec.ts (same-document and two-page BroadcastChannel cases with timing assertions)
Duration and stack-limit cases in the same spec
Accessibility case asserting aria-live polite and unchanged focus

## Estimated LOC delta
Added: 400  Deleted: 0  Net: +400

## Risk
Low; in-memory contract with a browser-native transport.
