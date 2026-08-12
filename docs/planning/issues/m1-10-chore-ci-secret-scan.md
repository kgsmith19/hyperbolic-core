Title: CHORE(ci): gitleaks secret-scan step in both PR gates
Type: CHORE
Component: hyperbolic-core
Milestone: M1 Platform foundations
Depends on: none
Blocks: none

## Problem
Guards' documented blind spot is a secret written via Bash landing in a commit unseen by the tool-call hook (SEC-05; 05-g-guards.md section 2c DECIDE). 10-cicd-deployment.md section 1.1 specifies the gitleaks step for toolbelt-ci.yml and acc-ci.yml (portable job), SHA-pinned, with a committed allowlist for the two deliberately public anon keys.

## Scope
In scope:
- Gitleaks step in .github/workflows/toolbelt-ci.yml and acc-ci.yml, action pinned by SHA
- Committed allowlist config covering the two public Supabase anon keys
Out of scope:
- Any Guards module change (Guards is not a CI control)
- Other workflows (shell-ci and brain-ci are born with the step)

## Acceptance criteria
When a PR diff introduces a secret-shaped string, the owning PR Gate shall fail.
When the scan runs against current main, it shall pass with zero findings.
Both workflow files shall reference the action by full commit SHA.

## Verification
Fixture branch adding a dummy AWS-style key; the gate fails on the scan step
gh run watch on a clean PR; scan step passes
grep -n "gitleaks" .github/workflows/toolbelt-ci.yml .github/workflows/acc-ci.yml shows uses: lines pinned to a 40-char SHA

## Estimated LOC delta
Added: 30  Deleted: 0  Net: +30

## Risk
Low; additive CI step with a committed allowlist to prevent false-positive noise.
