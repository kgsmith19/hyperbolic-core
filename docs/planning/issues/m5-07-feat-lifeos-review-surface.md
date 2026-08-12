Title: FEAT(lifeos): weekly review and briefing surface
Type: FEAT
Component: LifeOS
Milestone: M5 Component upgrades
Depends on: m2-08-feat-lifeos-shell-integration.md
Blocks: none

## Problem
The ops briefing cron already writes a daily narrative nobody can read without querying entities, and scheduled jobs leave execution receipts with no surface showing job health (05-e-lifeos.md section 2 candidate a, selected). LO-3 requires the selected features to pass their own EARS criteria.

## Scope
In scope:
- Read endpoint aggregating briefing entities and execution receipts for a date range, with missed-receipt detection
- Review page in the LifeOS zone consuming it
Out of scope:
- Any new kernel table (both features are domain-and-interface work per 05-e section 5); money, search, health, dispute, capture, calendar candidates (rejected with rationale in 05-e section 2)

## Acceptance criteria
The system shall serve a review feed aggregating briefing entities and execution receipts for a requested date range (LO-3a).
When a scheduled job has not left an execution receipt for its most recent slot, the review surface shall flag that job as missed (LO-3b).
The review feed endpoint shall respond within 300 ms p95 over seeded data (LO-3c).
The page shall render data within 500 ms warm.

## Verification
pytest tests/domains/ops/test_review_feed.py (in-range, out-of-range, and missed-gap cases)
Perf case in the same suite (50-call p95)
Playwright trace assertion for the page render budget
Standalone PR Gate run link recorded (LO-1)

## Estimated LOC delta
Added: 500  Deleted: 0  Net: +500

## Risk
Low; converts data the system already produces into a read surface.
