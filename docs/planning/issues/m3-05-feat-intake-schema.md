Title: FEAT(intake): intake schema with structural immutability
Type: FEAT
Component: Idea Intake
Milestone: M3 Toolbelt platform and Idea Intake
Depends on: m3-03-feat-toolbelt-scaffold-cli.md, m1-08-feat-db-rls-owner-repin.md
Blocks: m3-06-feat-intake-submit-api.md, m3-07-feat-intake-ui.md, m3-08-chore-acc-forgepad-supersession.md

## Problem
II-1 and II-3 demand that the draft to idea to submitted lifecycle and post-submit immutability be database properties, not app discipline (03-v1-definition.md section 9). Normative DDL, trigger rule specs, and grants are 05-h-idea-intake.md sections 1.2, 3.1, and 3.2; RLS policies instantiate the 06 section 5.5 pattern.

## Scope
In scope:
- Idea Intake scaffolded via the m3-03 CLI (tool.json, registration migration, directory layout)
- Migration pair creating intake.idea and intake.optimization with guard triggers, column-scoped grants, pinned RLS, and pgrst exposure, citing 05-h sections 1.2 and 3.1-3.2 as the contract
Out of scope:
- API routes (m3-06), UI (m3-07), optimize flow (m4-06)

## Acceptance criteria
Ideas shall move only draft to idea to submitted_to_github; the database shall reject every other transition (II-1a).
Ideas shall be born draft: status shall not be insertable and a service-context insert with another status shall raise (II-1b).
Once a row is submitted, no UPDATE or DELETE against it shall succeed at any layer (II-3a DB layer).
Derivatives shall fork submitted parents only (II-3c).

## Verification
psql transition matrix from 05-h section 12 II-1a: three forbidden updates raise, the allowed pair succeeds
psql: insert into intake.idea (title, status) values ('x','idea'); fails on the column grant; service-context variant raises via the insert guard
psql: update and delete against a submitted fixture both raise
psql: service-context derivative insert referencing a draft parent raises

## Estimated LOC delta
Added: 310  Deleted: 0  Net: +310

## Risk
Low; three independent enforcement layers fail closed together.
