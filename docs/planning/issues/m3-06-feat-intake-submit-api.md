Title: FEAT(intake): submit API with idempotent GitHub Issue creation
Type: FEAT
Component: Idea Intake
Milestone: M3 Toolbelt platform and Idea Intake
Depends on: m3-05-feat-intake-schema.md, m2-07-chore-ci-deploy-shell.md
Blocks: m3-07-feat-intake-ui.md, m4-06-feat-intake-optimize.md

## Problem
II-2 requires submit to create exactly one GitHub Issue idempotently, and II-3 requires that the app can never touch that Issue again. The call contract, error taxonomy, label scheme, and exact idempotency algorithm are 05-h-idea-intake.md sections 6 and 7; placement is the Shell serving unit's platform API (05-h section 6.1).

## Scope
In scope:
- /api/intake/* routes on the Shell serving unit, verified against the ADR-03 session
- GitHub client limited to create-issue and the existence check, PAT from Infisical /toolbelt/ (key TOOLBELT_GITHUB_INTAKE_PAT), never in the browser
- Idempotency algorithm and marker per 05-h section 6.5; error taxonomy handling per section 6.4; labels per section 7
Out of scope:
- UI (m3-07); optimize proxy (m4-06); any Issue update, comment, close, or label edit capability (structurally absent)

## Acceptance criteria
When an idea is submitted, the system shall create exactly one GitHub Issue with the 05-h section 7 labels, idempotently across two submits with the same idempotency key (II-2).
When submit fails per any 05-h section 6.4 class, the row shall remain at status idea with null github fields (II-5).
If a request reaches /api/intake/* without a valid platform session, then the system shall respond 401 within 50 ms (SH-4 for this API base).
An idempotent re-submit of a submitted idea shall return within 500 ms p95 with no GitHub call.

## Verification
E2E against a scratch repo: call submit twice; gh api 'repos/<o>/<r>/issues?labels=from-idea-intake&state=all' --jq '[.[] | select(.body | contains("idea=<uuid>"))] | length' prints 1
Fault-injection test per 6.4 class; select status, github_issue_number returns idea, null
curl -s -o /dev/null -w '%{http_code} %{time_total}\n' https://<origin>/api/intake/submit returns 401 under 0.05 plus RTT
Timed API test for the re-submit no-op path

## Estimated LOC delta
Added: 500  Deleted: 0  Net: +500

## Risk
Medium; the idempotency window across crashes is the hard part, bounded by the marker scan plus the unique partial index.
