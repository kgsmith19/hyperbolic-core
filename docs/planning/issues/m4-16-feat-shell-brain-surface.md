Title: FEAT(shell): the Brain run/chat surface in the ACC area
Type: FEAT
Component: Shell
Milestone: M4 The Brain
Depends on: m4-14-feat-brain-api-sse.md, m4-15-feat-ui-chat-primitives.md, m2-02-feat-shell-scaffold.md, m2-05-feat-shell-notifications.md
Blocks: none

## Problem
BR-4 requires the Brain to stream progress to the ACC UI and survive a UI reconnect without losing run state (03-v1-definition.md). The surface anatomy is 09-design-system.md section 7.1 and the transport is m4-14's SSE contract.

## Scope
In scope:
- Shell pages under /acc for the run surface: run tree panel, transcript, composer with send and stop, status strip, cost ticker, inline approval cards
- SSE client with Last-Event-ID resume; reconnect UX per 09 section 7.3 (status strip states, read-only composer after 10 s offline)
- Approval requests published into the notification surface
Out of scope:
- Porting the four existing ACC pages (post-V1 absorption, 05-b section 6)

## Acceptance criteria
When the operator starts a run, kills the socket, and reconnects, the surface shall resume from the store with no lost state (BR-4).
Stop shall be visible whenever run state is running, keyboard reachable, and always enabled.
After 10 s offline the transcript shall become visibly read-only with the composer disabled and a reason shown.
When an approval request arrives, an inline card shall render in the transcript and a notification shall publish through the platform surface.

## Verification
cd apps/shell && npx playwright test e2e/brain-run.spec.ts (reconnect case kills the socket and asserts resumed state)
Stop-button cases in the same spec
Offline read-only case with network emulation
Approval-card plus notification case

## Estimated LOC delta
Added: 700  Deleted: 0  Net: +700

## Risk
Medium; reconnect UX correctness depends on m4-14's replay guarantees.
