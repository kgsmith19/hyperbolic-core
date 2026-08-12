Title: CHORE(platform): add root npm workspace tooling
Type: CHORE
Component: hyperbolic-core
Milestone: M1 Platform foundations
Depends on: none
Blocks: m1-02-feat-platform-client-session.md, m1-03-feat-ui-tokens.md, m3-03-feat-toolbelt-scaffold-cli.md, m4-01-feat-llm-core.md, m4-08-feat-brain-daemon-state.md

## Problem
No package manifest exists anywhere at the repository root; every client hand-rolls its own Supabase fetch wrapper and no shared package can exist (02-health-audit.md section 5 item 5). ADR-01 budgets the repo's first workspace tooling at roughly 30 lines of root config (04-adrs.md ADR-01 decision).

## Scope
In scope:
- Root package.json with npm workspaces covering packages/* and apps/shell
- Root lockfile and .gitignore adjustments for workspace node_modules
Out of scope:
- Any package content (owned by m1-02, m1-03, m3-03, m4-01)
- Changes to existing apps' own package.json files

## Acceptance criteria
When npm ci runs at the repository root, the system shall exit 0 and resolve every directory declared in the workspaces field.
The change shall touch no file outside the repository root (no existing app manifest modified).

## Verification
npm ci && node -e "const p=require('./package.json'); if(!Array.isArray(p.workspaces)) process.exit(1)"
git diff --stat main -- apps/agentic-command-center apps/lifeos apps/toolbelt returns empty

## Estimated LOC delta
Added: 30  Deleted: 0  Net: +30

## Risk
Low; additive config only, no runtime behavior changes.
