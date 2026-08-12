Title: CHORE(toolbelt): delete the root idea client
Type: CHORE
Component: Toolbelt
Milestone: M3 Toolbelt platform and Idea Intake
Depends on: m3-04-feat-shell-tools-discovery.md, m3-07-feat-intake-ui.md
Blocks: none

## Problem
The root idea client's browser logic is untested (D-05) and is superseded by the Shell's registry-driven views and Idea Intake's list surface; 05-c-toolbelt.md section 9 resolves D-05 by deletion, timed so the operator always has one working idea view.

## Scope
In scope:
- Delete apps/toolbelt/web/index.html
- Remove the python3 -m http.server 8811 workflow lines from apps/toolbelt/AGENTS.md and README
Out of scope:
- apps/toolbelt/config.mjs (kept; root tests import it per 05-c section 9)

## Acceptance criteria
The file apps/toolbelt/web/index.html shall not exist and no doc shall reference the 8811 serving workflow.
The root toolbelt suite shall stay green.
This deletion shall land only after the Shell tools list and the Idea Intake list are both live.

## Verification
test ! -f apps/toolbelt/web/index.html && ! grep -rn "8811" apps/toolbelt/AGENTS.md apps/toolbelt/README.md
cd apps/toolbelt && node --test tests/
gh pr view shows m3-04 and m3-07 merged before this PR

## Estimated LOC delta
Added: 0  Deleted: 171  Net: -171

## Risk
Low; pure deletion with replacement surfaces already live.
