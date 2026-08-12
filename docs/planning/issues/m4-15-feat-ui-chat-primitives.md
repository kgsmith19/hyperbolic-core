Title: FEAT(ui): run/chat surface primitives
Type: FEAT
Component: hyperbolic-core
Milestone: M4 The Brain
Depends on: m1-04-feat-ui-primitives.md
Blocks: m4-16-feat-shell-brain-surface.md

## Problem
The Brain's UI needs transcript, tool-block, approval, composer, status, and cost components that do not exist; the complete anatomy, interaction rules, and streaming render budgets are 09-design-system.md sections 6 and 7.

## Scope
In scope:
- packages/ui chat pieces per 09 section 7: transcript blocks (operator, agent, tool call, system row), approval card with the evidence gate and y/n/d keys, composer, status strip, cost ticker
- Streaming behavior: per-frame coalesced DOM writes, bottom-anchored zero-shift transcript, autoscroll contract, virtualization above 200 items
Out of scope:
- SSE consumption and page wiring (m4-16); event schema (owned by 07)

## Acceptance criteria
The Approve control shall be disabled until the evidence panel has rendered on screen at least once.
A failed tool call shall auto-expand; collapsed blocks shall reserve summary-row height so streaming causes zero layout shift (CLS 0 on the run surface).
Above 200 transcript items the list shall virtualize with no frame over 32 ms at 1,000 items.
With the approval card focused, d shall toggle evidence, y approve, and n reject with an optional reason.

## Verification
node --test packages/ui/test/approval.test.mjs (evidence-gate and key cases)
Playwright perf spec asserting CLS 0 during streaming fixture playback
Perf trace at 1,000 virtualized items (frame budget)
Keyboard spec for the approval card

## Estimated LOC delta
Added: 900  Deleted: 0  Net: +900

## Risk
Medium; streaming render performance is the hardest UI budget in V1; cut order protects it last (07 section 7.14).
