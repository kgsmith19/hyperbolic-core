Title: FEAT(acc): kernel deny-roots alignment with Guards protected paths
Type: FEAT
Component: Agentic Command Center
Milestone: M5 Component upgrades
Depends on: m1-12-feat-guards-config-hardening.md
Blocks: none

## Problem
The kernel's alwaysDenyWriteRoots and Guards' protected list are two hand-maintained sets guarding overlapping territory; they will drift (05-g-guards.md section 3b). The no-import boundary forbids sharing code; sharing data is the sanctioned mechanism.

## Scope
In scope:
- Optional guardsConfigPath key in policy.json; when set, the kernel unions in the protected list read from Guards config plus the resolved profile overlay, as data
- Fail no-wider semantics: read failure adds nothing, logs a warning, built-in roots never shrink
Out of scope:
- Any import between ACC and Guards in either direction; merging the two guard systems (rejected with reversal condition in 05-g section 4)

## Acceptance criteria
When policy.json names a guardsConfigPath, the kernel's deny-write roots shall include every Guards protected path (ALN-1).
When the referenced file is unreadable, the built-in roots shall be unchanged and a warning logged.
The ACC suite and covgate shall stay green.

## Verification
cd apps/agentic-command-center && node --test kernel/policy.test.mjs (both ALN-1 cases)
npm test && npm run covgate

## Estimated LOC delta
Added: 40  Deleted: 0  Net: +40

## Risk
Low; failure mode is no wider, never no guard.
