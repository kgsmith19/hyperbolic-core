Title: CHORE(platform): IdP owner setup and CI owner-credential switch
Type: CHORE
Component: Toolbelt
Milestone: M1 Platform foundations
Depends on: m1-06-feat-db-platform-bootstrap.md
Blocks: m1-08-feat-db-rls-owner-repin.md, m2-03-feat-shell-login-gate.md

## Problem
ADR-03 makes the toolbelt Supabase project the platform IdP with exactly one owner user, and 06-supabase-schema.md section 5.4 resolves the CI transition: positive-path suites must switch to an owner credential before any policy re-pin, or CI breaks (sequence steps S2 and S3).

## Scope
In scope:
- Operator runbook step: create the owner user (kylegsmith19@gmail.com) in platform Auth with sign-ups disabled; insert the platform.config row; mint the owner refresh token into the secrets backend (GitHub secret first, Infisical later, per 06 gate question 2)
- CI PR: positive-path toolbelt suites read the owner token; fixture tokens re-scoped to negative-path assertions and test.scratch liveness writes
Out of scope:
- The re-pin migrations themselves (m1-08)
- LifeOS identity re-point (m2-08)

## Acceptance criteria
When the owner-credential exchange runs in CI, every positive-path toolbelt suite shall pass before any policy re-pin is applied.
If a sign-up is attempted against platform Auth, the request shall be refused.
The platform.config table shall contain exactly one row whose owner_uuid matches the auth.users row for the owner email.
No password or refresh token shall appear in any commit, log line, or command argument.

## Verification
Toolbelt PR Gate green on the CI PR with policies unchanged (S3 property)
curl -s -X POST "$SUPABASE_URL/auth/v1/signup" -H "apikey: $ANON" -d '{"email":"x@example.com","password":"xxxxxxxxxx"}' returns an error
psql (table-owner context): select count(*) from platform.config; returns 1
gitleaks detect on the PR diff returns zero findings

## Estimated LOC delta
Added: 40  Deleted: 10  Net: +30

## Risk
Medium; the token switch must merge and be observed green before m1-08, or CI breaks on re-pin.
