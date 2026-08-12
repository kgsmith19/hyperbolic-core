Title: FEAT(brain): key isolation checks, redaction, and injection fencing
Type: FEAT
Component: The Brain
Milestone: M4 The Brain
Depends on: m4-08-feat-brain-daemon-state.md
Blocks: m4-21-chore-ci-deploy-services.md

## Problem
BR-3 requires the Brain key to be unreadable by every other component, verified by mechanism; 07-brain-architecture.md section 7.10 specifies the scrubber, the names-only secrets design, and prompt-injection fencing over untrusted repo content.

## Scope
In scope:
- The ADR-05 isolation check script: attempt to read the /brain/ secrets path from a non-Brain process context, exit non-zero (used by BR-3 and II-4 verifications)
- Log and prompt-assembly scrubber: vault key names to placeholders, token-shaped strings masked
- Injection fencing: repo excerpts fenced as data blocks in planner prompts; tool allowlists sourced from the contract, never model output
Out of scope:
- Egress firewalling (ADR-06 deferral, risk-registered); container and identity mechanics (m4-21)

## Acceptance criteria
The Brain key shall be unreadable by every other component: the isolation check shall exit non-zero from a non-Brain process context (BR-3).
Vault key values shall never enter the Brain process: contracts carry names only, and a fixture run's environment audit shall show no key values.
When a token-shaped string enters a log line, the emitted line shall carry the masked form.
Tool allowlists in generated settings shall derive from the contract fields, with a test rejecting any allowlist sourced from model output.

## Verification
ADR-05 isolation check run in a non-Brain context; echo $? is non-zero
Environment audit assertion in the kernel-adapter fixture test
node --test services/brain/tests/scrubber.test.mjs
Allowlist-provenance unit test

## Estimated LOC delta
Added: 250  Deleted: 0  Net: +250

## Risk
Low; belt-and-suspenders over a names-only design already enforced by the kernel.
