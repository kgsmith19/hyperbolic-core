# lifeos runbook — hosting, deploys, auth, backups

Companion to [ADR 008](adr/008-hosting-deploy-auth.md). Everything here is
personal-scale on purpose: one VPS, one tailnet, one owner user.

Project references:
- prod: `vhbzblllaohuljtareza` — https://vhbzblllaohuljtareza.supabase.co
- test: `yueddwuhxflzbjehqufw` (local dev + `pytest` target; wiped by tests)
- publishable key (public by design, used only by `scripts/get_token.py`):
  `sb_publishable_rF0kYJWAjj1w9uwD4fr7ug_khrchuXJ`

## Environment variables (API runtime)

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres URL (lifeos_app). Session pooler on port 5432, `sslmode=require`. |
| `LIFEOS_AUTH_MODE` | `supabase` (default, deployed) or `disabled` (local dev/tests only). |
| `LIFEOS_SUPABASE_URL` | `https://<ref>.supabase.co` — issuer/JWKS derive from it. |
| `LIFEOS_OWNER_USER_ID` | UUID of the single allowed Supabase Auth user. |
| `LIFEOS_AUTH_AUDIENCE` | Optional, defaults to `authenticated`. |
| `LIFEOS_SUPABASE_PUBLISHABLE_KEY` | Only for `scripts/get_token.py`. |

## One-time setup

### 1. Supabase dashboard (prod project) — human required
1. Authentication → Sign In / Up: **disable "Allow new users to sign up"**.
2. Add the one owner user (email + strong password), confirm it, and copy its
   UUID → becomes `LIFEOS_OWNER_USER_ID`.
3. Authentication → MFA: enroll TOTP on the owner account.
4. Database → Settings: **enforce SSL** on connections.
5. (Already done via migration `20260726004147`: RLS deny-all on kernel
   tables. Signing keys are already asymmetric ES256 — verified via JWKS.)

### 2. Tailscale — human required
1. Create a tailnet (free Personal plan), sign in on your devices, and turn
   on **device approval** (Settings → Device management).
2. ACL (Access Controls), add tags + Tailscale SSH rule:
   ```json
   "tagOwners": {
     "tag:prod": ["autogroup:admin"],
     "tag:ci":   ["autogroup:admin"]
   },
   "ssh": [
     {"action": "accept", "src": ["tag:ci"], "dst": ["tag:prod"], "users": ["deploy"]}
   ]
   ```
3. Settings → OAuth clients → new client with the `auth_keys` scope,
   tag `tag:ci` → gives `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET`.

### 3. VPS (Hetzner CPX11, Ashburn ~US$6/mo) — human creates, then paste
As root on fresh Ubuntu 24.04:
```bash
apt-get update && apt-get -y upgrade
apt-get -y install ca-certificates curl unattended-upgrades
curl -fsSL https://get.docker.com | sh
curl -fsSL https://tailscale.com/install.sh | sh
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
mkdir -p /home/deploy/lifeos && chown deploy:deploy /home/deploy/lifeos
tailscale up --ssh --advertise-tags=tag:prod   # approve the node in the admin console
tailscale serve --bg --https=443 http://127.0.0.1:8000
ufw default deny incoming && ufw default allow outgoing
ufw allow in on tailscale0 && ufw enable
```
Then as `deploy`:
```bash
# No registry auth needed: CI streams images over Tailscale SSH
# (docker save | docker load), so the VPS holds no GHCR credentials.
# No manual .env here either: every deploy renders lifeos/.env from
# Infisical (chmod 600) — see the Infisical section below.
```
In the admin console: disable key expiry for the VPS node. The API is then
`https://<vps-name>.<tailnet>.ts.net` on every signed-in device (that name is
`DEPLOY_HOST`).

### 4. Infisical — human required (the one protected spot, ADR 009)
1. Sign up at https://app.infisical.com (free tier), create org + project
   `lifeos` (note the project slug) with environments `prod` and `dev`.
2. In `prod`, add these secrets (names must match exactly — they export as
   env vars in CI): `DATABASE_URL` (prod lifeos_app session-pooler URL with
   `sslmode=require`), `LIFEOS_SUPABASE_URL`, `LIFEOS_OWNER_USER_ID`,
   `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` (from Tailscale step 2.3).
3. Organization → Identities → create `github-actions` with **OIDC Auth**:
   issuer `https://token.actions.githubusercontent.com`, subject bound to
   `repo:kgsmith19/lifeos:*`. Add it to project `lifeos` with read-only
   access to `prod`, and copy the identity ID.
4. Optionally mirror lifeos-test values into `dev` for future use.

### 5. GitHub repo configuration — human required (Settings → Secrets and variables → Actions)
**No Actions secrets — variables only.** All are non-secret: the Infisical
identity is bound to this repo's OIDC claims, so leaking them grants nothing.
| Variable | Value |
|---|---|
| `INFISICAL_PROJECT_SLUG` | from Infisical step 1 |
| `INFISICAL_IDENTITY_ID` | from Infisical step 3 |
| `DEPLOY_ENABLED` | `true` once the VPS exists (until then the deploy job skips) |
| `DEPLOY_HOST` | the VPS tailnet DNS name |
| `BACKUP_ENABLED` | `true` to turn on nightly dumps |
| `AGE_PUBLIC_KEY` | from `age-keygen` below |

Create a `production` environment (Settings → Environments) so deploy history
is visible; add required reviewers later if wanted.

### 6. Backup key — human required, key stays offline
```bash
age-keygen -o lifeos-backup.key     # prints the public key
```
Put the **public** key in the `AGE_PUBLIC_KEY` variable. Keep
`lifeos-backup.key` (the private key) in your password manager — it is the
only way to read backups and must never enter the repo or CI.

## Deploys
Merge to `main` → `ci.yml`: checks (ruff, mypy, pytest against ephemeral
pgvector Postgres with all migrations applied) → image to GHCR (`:main` +
`:sha-<commit>`) → fetch prod secrets from Infisical via OIDC → migrations
via `supabase db push` → render + ship the VPS `.env` → compose pull/up over
Tailscale SSH → `/healthz` smoke check (verifies DB connectivity).

Rollback: on the VPS as `deploy`:
```bash
cd ~/lifeos && LIFEOS_IMAGE=ghcr.io/kgsmith19/lifeos:sha-<previous sha> docker compose up -d
```
Database changes roll forward (append-only log); never down-migrate.

## Backups and restore drill
Nightly `backup.yml` dumps `--schema=public` with `pg_dump`, encrypts to the
age public key, keeps 30 days of artifacts. Restore drill (quarterly, or
before anything risky):
```bash
age -d -i lifeos-backup.key -o lifeos.dump lifeos.dump.age
docker run -d --name restore -e POSTGRES_PASSWORD=pg -p 5433:5432 pgvector/pgvector:pg17
psql postgresql://postgres:pg@localhost:5433/postgres -c 'create schema if not exists extensions; create extension vector with schema extensions'
pg_restore --no-owner -d postgresql://postgres:pg@localhost:5433/postgres lifeos.dump
psql postgresql://postgres:pg@localhost:5433/postgres -c 'select count(*) from event'
```
A backup that has never been restored is a hope, not a backup.

## Local development
`.env` in the repo root (never committed):
```
DATABASE_URL=<lifeos-test session-pooler URL>   # tests WIPE this database
LIFEOS_AUTH_MODE=disabled
LIFEOS_SUPABASE_URL=https://vhbzblllaohuljtareza.supabase.co
LIFEOS_SUPABASE_PUBLISHABLE_KEY=sb_publishable_rF0kYJWAjj1w9uwD4fr7ug_khrchuXJ
```
Point `DATABASE_URL` at the **lifeos-test** project only. (Optional later:
`infisical run --env=dev -- <cmd>` can replace the local file entirely.)
Calling the deployed API: `python scripts/get_token.py` prints a bearer token
(sign-in with the owner email/password); pass it as
`Authorization: Bearer <token>`.

## Costs
VPS ~$6/mo. Tailscale, GitHub (private repo, Actions, GHCR), Supabase free
tier, backups: $0. Flip to Supabase Pro ($25/mo — managed daily backups, no
pausing, network restrictions) when the data becomes load-bearing.
