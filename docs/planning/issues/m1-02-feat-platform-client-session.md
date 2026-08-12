Title: FEAT(platform-client): session and authed fetch package
Type: FEAT
Component: hyperbolic-core
Milestone: M1 Platform foundations
Depends on: m1-01-chore-platform-workspace-setup.md
Blocks: m2-02-feat-shell-scaffold.md, m2-03-feat-shell-login-gate.md, m3-04-feat-shell-tools-discovery.md

## Problem
Three disjoint auth flows exist today and no shared session client exists (02-health-audit.md headline; 05-a-hyperbolic-core.md section 1). ADR-03 requires one Shell-level session propagated through packages/platform-client; the binding interface is 05-a section 6.

## Scope
In scope:
- packages/platform-client implementing the PlatformClient, PlatformAuth, PlatformSession, and AuthedFetch signatures of 05-a section 6
- Unit tests with an injected transport spy
Out of scope:
- Registry client (m3-04)
- Any UI, login form, or zone wiring (M2)

## Acceptance criteria
When signInWithPassword succeeds against the platform IdP, getSession shall return a session whose userId equals the owner UUID.
If no session exists, then AuthedFetch shall reject without issuing any network request.
While the IdP is unreachable and the token is expired, getSession shall return null and no authenticated call shall be issued.
A zone calling signInWithPassword outside the Shell shall remain detectable by the LO-2b grep contract (the package exports exactly one login entry point).

## Verification
cd /home/user/hyperbolic-core && node --test packages/platform-client/tests/ (transport-spy cases assert zero fetches on the reject paths)
npx tsc -b packages/platform-client
grep -c "export declare function createPlatformClient\|export function createPlatformClient" packages/platform-client/src/index.ts returns 1

## Estimated LOC delta
Added: 250  Deleted: 0  Net: +250

## Risk
Low; pure client library with a frozen interface from 05-a.
