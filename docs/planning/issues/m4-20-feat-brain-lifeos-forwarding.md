Title: FEAT(brain): scoped LifeOS surface and proposal lane
Type: FEAT
Component: The Brain
Milestone: M4 The Brain
Depends on: m4-14-feat-brain-api-sse.md, m2-08-feat-lifeos-shell-integration.md
Blocks: none

## Problem
LO-4 requires the Brain's LifeOS surface to be callable and scope-limited: read lanes plus a proposal-only write lane with a human gate (03-v1-definition.md; 05-e-lifeos.md section 3; 07-brain-architecture.md section 7.12).

## Scope
In scope:
- LifeOsSurface client in services/brain per the 05-e section 3 signature: exactly search, getEntity, getHistory, listTypes, proposeAction
- LifeOS-side scope table addition and proposal-lane tests (standalone repo, the one sanctioned change beyond m2-08)
- Token minting per task class with read scopes plus action-proposals:draft only
Out of scope:
- LifeOS chat handing work to the Brain (rides the programmatic API when LifeOS wires it; API already live via m4-14)

## Acceptance criteria
When the Brain presents a read-scoped token, search, getEntity, getHistory, and listTypes shall succeed, and the surface shall expose exactly 5 methods (LO-4a).
If the Brain calls proposeAction, then a pending proposal shall appear in Approvals and no entity shall change until operator approval (LO-4b).
If any agent token requests a write scope other than action-proposals:draft or a wildcard, then minting shall be refused (LO-4c).

## Verification
Programmatic call script against the section 3 contract; type-level test asserting exactly 5 methods
Integration test: propose, assert proposal pending and target entity unchanged; approve via the existing endpoint, assert applied
pytest token-scope suite in the standalone repo extended with the new scope table

## Estimated LOC delta
Added: 250  Deleted: 0  Net: +250

## Risk
Low; both lanes ride existing LifeOS mechanisms; invariants 7 and 8 hold by construction.
