Title: FEAT(network-checker): consent-gated change lifecycle
Type: FEAT
Component: Network Checker
Milestone: M5 Component upgrades
Depends on: m5-03-feat-nc-inventory.md
Blocks: none

## Problem
Remediation exists only as three human-run scripts with no propose, dry-run, approve, verify, or rollback structure (02-health-audit.md section 6). NC-4 forbids any configuration write without a recorded dry run and an explicit approval token; the record, CLI flow, token mechanism, rollback contract, and template migration are 05-f sections 4 and 4.5.

## Scope
In scope:
- change_request record and invariants per 05-f section 4.1; CLI flow per 4.2; TTY-only approval and hash-bound token per 4.3; bounded auto-rollback per 4.4
- The three fix templates seeded per 4.5; rank fix text repointed to the lifecycle; run_fixes.sh deleted
- AGENTS.md invariant amendment replacing the blanket exclusion with the consent-gated wording (05-f preamble; gate question 1 wording confirmed)
Out of scope:
- Any browser or Brain approval surface (TTY-only by design, 05-f gate question 2); new device write capabilities beyond the three templates

## Acceptance criteria
If change apply is invoked without a recorded dry run and a valid approval token, then the system shall exit non-zero and record no device write (NC-4.1).
While stdin is not a TTY, change approve shall refuse and exit non-zero (NC-4.2).
When change_cmd or inverse_cmd changes after approval, the previously issued token shall be rejected at apply time (NC-4.3).
When post-apply verification fails, the system shall run the inverse automatically and record status rolled_back with captured outputs (NC-4.4).
The three fix templates shall exist as proposable changes and rank fix text shall reference the lifecycle, not raw script invocations (NC-4.5).

## Verification
python3 -m unittest tests.test_change (token, dry-run, binding, and rollback cases); manual proof per the 05-f NC-4.1 command sequence with the sqlite applied_at query returning empty
echo 1 | python -m netcheck change approve 1; test $? -ne 0
Token-binding case in tests.test_change
Rollback case with a fake executor whose verify fails
python3 -m unittest tests.test_rank tests.test_change; grep -n "run_fixes.sh" apps/toolbelt/apps/network-checker/netcheck/rank.py returns zero hits

## Estimated LOC delta
Added: 740  Deleted: 91  Net: +649

## Risk
Medium; amends a committed product invariant; the replacement keeps unattended writes forbidden and adds the token gate.
