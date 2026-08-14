---
title: Platform IdP Owner Setup Runbook
status: active
scope: repo
created: 2026-08-12
updated: 2026-08-12
owner: Kyle
---

# Platform IdP Owner Setup Runbook

Operator-only steps for `docs/planning/issues/m1-07-chore-platform-idp-owner-setup.md`
(migration sequence steps S2 and S3, `docs/planning/06-supabase-schema.md`
section 5.4). These cannot be performed from a coding session: they require
the Supabase dashboard/Auth admin API and a GitHub repository secret, neither
of which any agent in this repo has credentials for.

None of this is blocking for the code already merged (the `primaryToken()`
fallback in `apps/toolbelt/tests/helpers.mjs` keeps CI green without it). It
**is** a hard prerequisite for `docs/planning/issues/m1-08-feat-db-rls-owner-repin.md`:
once that migration re-pins RLS to the owner UUID, fixture tokens lose all
`core`/`idea`/`prompt` access, and the `primaryToken()` fallback stops being
sufficient. Do this before merging m1-08, not after.

## Steps

1. **Create the owner user in the platform (toolbelt) Supabase project**
   (`woltgcggxaehtuypkxqk`), Auth panel: email `kylegsmith19@gmail.com`,
   a real password of your choosing. Disable public sign-ups on this project
   first (Auth settings), mirroring the LifeOS runbook precedent.
2. **Insert the one `platform.config` row**, as the table owner (SQL editor
   or `psql`, never through PostgREST — the table has no API grant by
   design):
   ```sql
   insert into platform.config (owner_uuid)
   values ('<the auth.users.id UUID from step 1>');
   ```
   Until this row exists, `platform.owner()` returns null and every
   owner-pinned policy evaluates false (fail closed) — this is deliberate,
   not a bug to troubleshoot.
3. **Mint an owner session for CI.** Exchange the owner's credentials for a
   session once, then store the resulting tokens as GitHub Actions
   **repository secrets** (the Secrets tab, never the Variables tab — a
   repository variable is stored in plaintext and shown in the UI):

   - `TOOLBELT_OWNER_REFRESH_TOKEN` — the `refresh_token`. **This is the one
     that matters.** It is long-lived, and both `toolbelt-ci.yml` and
     `platform-contract.yml` exchange it for a fresh access token at job
     start via `apps/toolbelt/apps/prompt-organizer/tests/export-test-sessions.mjs`.
     Set this and CI stops needing attention.
   - `TOOLBELT_OWNER_TOKEN` — the `access_token`. Accepted as a short-lived
     compatibility fallback only (`tests/owner-session.mjs` prefers it when
     present). It expires in about an hour, so a run that starts after that
     fails exactly as if no credential had ever been set. Do not rely on it
     alone.

   Two ways to get a session, neither of which stores a password anywhere:
   the `/auth/v1/token?grant_type=password` flow `apps/toolbelt/tests/helpers.mjs`
   uses for fixtures, or a magic link sent from the Auth → Users panel, whose
   redirect lands with `#access_token=...&refresh_token=...` in the URL
   fragment (the landing page 404ing is fine; the tokens are in the address
   bar regardless). Both are stopgaps until the ADR-05 Infisical
   machine-identity path takes over (`docs/planning/06-supabase-schema.md`
   gate question 2 — GitHub secret first, Infisical later, deliberately).
   Never put the password or either token in a commit, a command's argv, or a
   log line.

   To confirm the plumbing without reading a token: a correctly-set secret
   prints as `TOOLBELT_OWNER_TOKEN: ***` in the job's env block, while an
   unset or misplaced one prints blank. `export-test-sessions.mjs` also runs
   `verifyOwnerAccessToken()`, which fails the step outright if the resolved
   session is not `platform.owner()` — so a wrong credential is reported as
   itself rather than as a downstream test failure.
4. **Confirm sign-ups are actually refused**:
   ```bash
   curl -s -X POST "https://woltgcggxaehtuypkxqk.supabase.co/auth/v1/signup" \
     -H "apikey: <anon key>" -d '{"email":"x@example.com","password":"xxxxxxxxxx"}'
   ```
   must return an error, not a created user.
5. **Watch the next `Toolbelt PR Gate` run** after the secret is set: the
   "Run Toolbelt tests" step should show `TOOLBELT_OWNER_TOKEN` taking effect
   (positive-path suites authenticating as the owner instead of falling back
   to the `toolbelt-test-a` fixture). Nothing else changes yet — RLS policies
   are still unpinned at this point (S3 is backward-compatible by
   construction), so this run should be green either way; it is confirming
   the token plumbing works before m1-08 makes it load-bearing.

## Why this can't be automated from here

- No coding session in this repo holds Supabase project-admin or Auth-admin
  credentials (only the public anon key, which cannot create users or read
  `platform.config`).
- No coding session holds `secrets:write` access to this GitHub repository.
- Both are intentional per ADR-05 (secrets and key management): credential
  minting is a human, out-of-band act, not something a CI job or an agent
  does to itself.
