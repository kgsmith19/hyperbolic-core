Title: FEAT(guards): machine-profile overlay and decision audit trail
Type: FEAT
Component: Guards
Milestone: M1 Platform foundations
Depends on: none
Blocks: m4-07-feat-guards-harness-registration.md, m5-09-feat-acc-kernel-deny-roots.md

## Problem
Guards' config.json carries Windows-machine absolute paths as its only reality and cannot express a second machine, yet GU-2 requires Guards to run wherever Brain- and ACC-launched sessions run (05-g-guards.md section 3a). Denials also leave no persistent record for Brain debugging (05-g section 3c).

## Scope
In scope:
- Per-machine overlay loader per 05-g section 3a: tracked base keeps enabled and secrets; overlay file config.<profile>.json carries runboxDir, protected, repos; GUARDS_PROFILE env then hostname resolution; GUARDS_CONFIG bypass preserved
- Split of current Windows values into the first overlay file; config.example.json updated
- JSONL audit trail per 05-g section 3c: GUARDS_LOG append of one record per decision, best-effort, never changing the decision
Out of scope:
- Generated-settings registration in launchers (m4-07)
- Kernel deny-roots alignment (m5-09)

## Acceptance criteria
The existing suite shall stay green throughout (GU-1).
While a launcher runs with a profile overlay, Guards shall enforce that machine's protected and repo rules with no edit to the tracked base config (GU-2.3).
If the config file cannot be read or no parsable payload arrives within the cap, then the hook shall deny with exit 2 (GU-3.1, GU-3.2).
When a decision is made and GUARDS_LOG is set, the system shall append exactly one JSONL record carrying ts, tool, target, allow, rule (AUD-1).
If the audit append fails, then the decision outcome shall be unchanged (AUD-2).
The hook shall add at most 50 ms p95 per intercepted tool call (LAT-1).

## Verification
cd apps/toolbelt/guards && node --test "*.test.mjs"
GUARDS_PROFILE=fixture node --test guard.test.mjs (overlay-merge cases)
printf '{}' | GUARDS_CONFIG=/nonexistent/cfg.json node apps/toolbelt/guards/guard.mjs; test $? -eq 2
Run one denied fixture payload with GUARDS_LOG=$(mktemp); wc -l < "$GUARDS_LOG" prints 1 and the line parses as JSON
Timed loop of 20 invocations; p95 wall clock below 50 ms

## Estimated LOC delta
Added: 135  Deleted: 0  Net: +135

## Risk
Low; the merge is trivial JSON and logging never alters decisions.
