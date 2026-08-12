Title: FEAT(guards): automatic registration in every generated harness session
Type: FEAT
Component: Guards
Milestone: M4 The Brain
Depends on: m1-12-feat-guards-config-hardening.md
Blocks: m4-10-feat-brain-kernel-adapter.md

## Problem
GU-2 requires the V1 enforcement set registered and active for every Brain- and ACC-launched harness session; today registration is manual on the operator machine only (05-g-guards.md section 2). The registration contract, block shape, and failure semantics are 05-g section 5.

## Scope
In scope:
- Generated-settings Guards entry emitted by the ACC kernel settings writer and the runner launch path, and specified as the contract the Brain's writer must satisfy (05-g section 5 block shape, matcher, 15 s timeout, GUARDS_CONFIG or GUARDS_PROFILE resolution, optional per-run GUARDS_LOG)
- Launcher metadata surfacing when enabled:false so a disabled guard is never silent
Out of scope:
- Interactive-session registration (stays manual per 05-g section 2b); the Brain writer implementation itself (lands inside m4-10 against this contract)

## Acceptance criteria
When the ACC kernel generates run settings, the PreToolUse chain shall include the Guards hook entry with machine resolution (GU-2.1).
When any launched harness session attempts a write to a protected fixture path, the call shall be denied with exit 2 and the denial recorded (GU-2.2).
A hook timeout or nonzero hook exit shall be treated by launchers as a denied tool call, never an allow.
While enabled:false is set, run metadata shall record the disabled state.

## Verification
cd apps/agentic-command-center && npm test (new kernel/settings.test.mjs assertion that generated settings contain a command matching guards/guard.mjs)
Kernel fixture run: write to a protected path exits 2 and grep -c '"allow":false' "$GUARDS_LOG" is at least 1
Launcher unit case: simulated hook timeout maps to deny
Run-metadata case for the disabled state

## Estimated LOC delta
Added: 60  Deleted: 0  Net: +60

## Risk
Low; the generated-settings pattern already exists in the kernel; this widens its emission.
