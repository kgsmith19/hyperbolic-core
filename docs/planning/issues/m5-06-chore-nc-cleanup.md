Title: CHORE(network-checker): delete synthesis stub, fix stale labels, refresh docs
Type: CHORE
Component: Network Checker
Milestone: M5 Component upgrades
Depends on: none
Blocks: none

## Problem
synthesis.py is a deliberately unwired stub imported by nothing but its own test (dead-code register), the Dockerfile and README point at defunct repositories (D-10), and the AGENTS.md layout table under-documents 6 wired modules (02-health-audit.md gap register). Decisions are 05-f sections 5 and 6.

## Scope
In scope:
- Delete netcheck/synthesis.py and tests/test_synthesis.py (closes issue 93 by rejection)
- Repoint Dockerfile image-source label and README quick-start to hyperbolic-core (05-f D-10 edit list)
- AGENTS.md layout table refresh: add bundle, experiment, exposure, geoip, topology rows plus the new inventory and change modules
Out of scope:
- Wiring any LLM summary seam (re-creatable when the feature clears the ROI bar post-V1)

## Acceptance criteria
No file in the app shall reference the defunct standalone repositories (D-10).
The repository shall contain no synthesis module or test.
The suite and scanners shall stay green after the deletions.

## Verification
grep -rn "kgsmith19/network-checker\|kgsmith19/toolbelt" apps/toolbelt/apps/network-checker/ returns zero hits
test ! -f apps/toolbelt/apps/network-checker/netcheck/synthesis.py && test ! -f apps/toolbelt/apps/network-checker/tests/test_synthesis.py
bash tools/check.sh exits 0

## Estimated LOC delta
Added: 9  Deleted: 79  Net: -70

## Risk
Low; deletions of unwired code and doc edits.
