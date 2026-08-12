Title: FIX(network-checker): watch loop test and dashboard smoke
Type: FIX
Component: Network Checker
Milestone: M5 Component upgrades
Depends on: none
Blocks: none

## Problem
watch.py is the only netcheck module with no dedicated test (D-03), and the entire dashboard frontend has zero tests (D-04) (02-health-audit.md). The hermetic test spec is 05-f section 5 (D-03) and the single-Playwright-smoke decision is 05-f section 5 (D-04).

## Scope
In scope:
- tests/test_watch.py hermetic suite covering tick storage, route re-resolution, idle-hold cadence, mirror invocation, and startup scan per the 05-f injection-point spec
- One hermetic Playwright smoke: serve the fixture SQLite database, assert rendered rows, one SSE update, and the export download; CI step in toolbelt-ci.yml
Out of scope:
- A JS unit-test harness (rejected with rationale in 05-f section 5)

## Acceptance criteria
watch.py shall have a dedicated hermetic test and the discovered suite count shall strictly exceed 298 (NC-2).
The existing suite and scanners shall stay green (NC-1).
The dashboard shall render seeded data and one SSE update under the hermetic smoke (D-04).

## Verification
python3 -m unittest tests.test_watch
python3 -m unittest discover -s tests -t . (count > 298); bash tools/check.sh exits 0
npx playwright test per the toolbelt-ci.yml step (serve on 127.0.0.1:8787 against the fixture DB)

## Estimated LOC delta
Added: 235  Deleted: 0  Net: +235

## Risk
Low; test-only additions against existing seams.
