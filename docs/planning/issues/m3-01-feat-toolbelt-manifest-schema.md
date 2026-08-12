Title: FEAT(toolbelt): tool.json contract schema and manifest validator
Type: FEAT
Component: Toolbelt
Milestone: M3 Toolbelt platform and Idea Intake
Depends on: none
Blocks: m3-02-feat-toolbelt-registry-extension.md, m3-03-feat-toolbelt-scaffold-cli.md

## Problem
Nothing defines what a tool is: no manifest, no declared inputs/outputs, no permissions model, no lifecycle hooks (02-health-audit.md section 5 item 1). TB-1 requires every tool to carry a validated manifest; the normative JSON Schema is 05-c-toolbelt.md section 3.2.

## Scope
In scope:
- apps/toolbelt/tool.schema.json exactly per 05-c section 3.2
- Manifest validator (npm run manifests:check) with global schema-ownership uniqueness and the registry hash parity mode
- CI wiring of the validator into toolbelt-ci.yml
Out of scope:
- Manifest files for existing tools (m3-02); runtime enforcement of permissions (review-enforced in V1 per 05-c section 3.2)

## Acceptance criteria
When the validator runs over all manifests, a conforming set shall exit 0 within 5 seconds (TB-1a).
If a manifest declares a permissions.db.write schema owned by another manifest, then the validator shall fail (TB-5).
When a PR contains an invalid manifest, the Toolbelt PR Gate shall fail.

## Verification
npm run manifests:check (timed; exits 0 under 5 s)
npm run manifests:check against the deliberately colliding fixture exits non-zero
Fixture PR with an invalid manifest; Toolbelt PR Gate fails on the validator step

## Estimated LOC delta
Added: 380  Deleted: 0  Net: +380

## Risk
Low; validation only, no behavior change to any tool.
