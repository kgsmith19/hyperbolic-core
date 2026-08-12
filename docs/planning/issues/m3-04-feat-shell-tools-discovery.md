Title: FEAT(shell): registry client and registry-driven tool discovery
Type: FEAT
Component: Shell
Milestone: M3 Toolbelt platform and Idea Intake
Depends on: m3-02-feat-toolbelt-registry-extension.md, m2-02-feat-shell-scaffold.md, m1-02-feat-platform-client-session.md
Blocks: m3-09-chore-toolbelt-root-client-deletion.md

## Problem
Nothing enumerates or launches tools; discovery is hardcoded lists and separate ports (02-health-audit.md section 5 item 3). TB-2 requires the Shell to render discovery from the registry; the client interface is 05-c section 4.3.

## Scope
In scope:
- RegistryClient in packages/platform-client per the 05-c section 4.3 signatures
- Shell /tools page: navigation entries for rows with routes, status page rows for headless tools, retired rows hidden (TB-6)
- Palette tool entries fed from the registry
Out of scope:
- Tool content pages (owned by each tool); manifest authoring (m3-02)

## Acceptance criteria
When a fixture manifest and its generated registration migration are added on a temp branch, the Shell shall list the fixture tool with zero Shell code change (TB-2).
While a tool row has status retired, the Shell shall not render it in navigation (TB-6).
The registry list query shall return within 200 ms p95 from a warm client, and session-ready to nav painted shall stay within 300 ms p95.

## Verification
Scripted TB-2 check: add fixture, supabase db push, npx playwright test e2e/tools.spec.ts asserts the entry, git diff --stat apps/shell/ is empty
SQL sets the fixture row retired; the same spec asserts absence; down migration restores
Perf cases in the tools spec (50-call p95 for the query; trace timing for nav paint)

## Estimated LOC delta
Added: 350  Deleted: 0  Net: +350

## Risk
Low; one query and one page over an already-policied table.
