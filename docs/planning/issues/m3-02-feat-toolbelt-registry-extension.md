Title: FEAT(toolbelt): extend core.app registry and register existing tools
Type: FEAT
Component: Toolbelt
Milestone: M3 Toolbelt platform and Idea Intake
Depends on: m3-01-feat-toolbelt-manifest-schema.md, m1-08-feat-db-rls-owner-repin.md
Blocks: m3-03-feat-toolbelt-scaffold-cli.md, m3-04-feat-shell-tools-discovery.md, m4-05-feat-llm-handler-service.md

## Problem
core.app is a bare registry row and exactly one app has ever been registered, by hand-written migration (02-health-audit.md section 5 item 2). TB-1b requires the registry to list every manifest with a matching hash; the extension DDL is 05-c section 4.1 and the generated-registration contract is 05-c section 4.2.

## Scope
In scope:
- Migration pair extending core.app per 05-c section 4.1, plus the one data line for prompt-organizer
- tool.json manifests for the root spine, Prompt Organizer, and Network Checker (05-c gate question 1 default: Network Checker listed, kind cli, no route)
- Generated registration migration pairs for those manifests with manifest_hash sha256 parity
Out of scope:
- The scaffold CLI that generates future registrations (m3-03); Idea Intake registration (born from the scaffold in m3-05)

## Acceptance criteria
When the migrations apply, the registry shall list every registered manifest and recomputed hashes shall match (TB-1b).
The registration migrations shall be idempotent upserts: re-running shall leave row counts unchanged.
Retirement shall be expressible as a generated status update, never a delete.

## Verification
npm run manifests:check -- --registry exits 0
psql: select count(*) from core.app where status <> 'idea'; equals the count of manifests with a registration migration
Apply a registration migration twice; row count query unchanged

## Estimated LOC delta
Added: 220  Deleted: 0  Net: +220

## Risk
Low; additive columns with defaults, one data line for the existing row.
