Title: FEAT(shell): one-origin tailscale serve routing
Type: FEAT
Component: Shell
Milestone: M2 Shell and auth
Depends on: m2-02-feat-shell-scaffold.md
Blocks: m2-07-chore-ci-deploy-shell.md

## Problem
Today every surface lives on its own port with its own sign-in; ADR-02/ADR-07 require one tailnet origin path-routing the Shell zone, the LifeOS zone, and upstream APIs with zero new deployable units (04-adrs.md ADR-07; 05-a section 11 rank 1; 10-cicd-deployment.md section 4 route table).

## Scope
In scope:
- tailscale serve route config on the VPS per the 10 section 4 table (/, /life/*, /life/api/*, /brain/stream reserved), applied by an idempotent operator step, documented as keys in the runbook
- Shell /healthz static route for SH-5 verification
Out of scope:
- Any auth at the edge (ADR-07: serve does zero app auth)
- Deploy automation (m2-07); the Brain upstream itself (m4-21)

## Acceptance criteria
When a tailnet browser requests the origin root, the Shell bundle shall be served.
When a tailnet browser requests /life/*, the LifeOS frontend dist shall be served and /life/api/* shall proxy to the loopback LifeOS API.
The origin shall serve /healthz with status 200.
No service beyond the origin shall listen on a non-loopback interface.

## Verification
curl -s -o /dev/null -w '%{http_code}' https://<origin>/ returns 200 with the Shell index asset hash
curl -s -o /dev/null -w '%{http_code}' https://<origin>/life/ returns 200
curl -s -o /dev/null -w '%{http_code}' https://<origin>/healthz returns 200
ssh deploy@host ss -tlnp shows only loopback binds beyond tailscaled

## Estimated LOC delta
Added: 40  Deleted: 0  Net: +40

## Risk
Medium; the /life/* re-path changes LifeOS URLs and must land with m2-08's base-path train.
