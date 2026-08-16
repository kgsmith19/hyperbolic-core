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
| `LIFEOS_ROOT_PATH` | Optional (m2-08). Set to `/life/api` when this API is reached through the one-origin `tailscale serve` mount (`docs/ops/tailscale-serve-apply.sh`'s `/life/api/` route), which forwards the full path rather than stripping it. Unset in the standalone-repo deploy shape, where the API is the origin's whole path space. See "Auth re-point to the platform IdP (m2-08)" below. |
| `LIFEOS_SUPABASE_PUBLISHABLE_KEY` | Only for `scripts/get_token.py`. |
| `LIFEOS_ICS_URLS` | Comma-separated ICS feed URLs for the ingestion job (ADR 012). |
| `LIFEOS_BRIEFING_TZ` | Optional IANA zone deciding the briefing's "today"; defaults to UTC. |
| `LIFEOS_BLOB_ROOT` | Optional document blob store root (ADR 015); defaults to `var/blobs` beside the process, which compose mounts as the `lifeos-blobs` volume. |
| `LIFEOS_EXTRACT_MODEL` | Optional model for bill extraction (ADR 016); defaults to `claude-opus-5`. |
| `LIFEOS_EXTRACT_EFFORT` | Optional effort for bill extraction; defaults to `medium`. |
| `LIFEOS_SLEEPHQ_CLIENT_ID` / `LIFEOS_SLEEPHQ_CLIENT_SECRET` | SleepHQ OAuth2 client-credentials (roadmap H2). Provisioned via the guards vault; missing either is a `skipped` execution receipt, never a crash. |
| `LIFEOS_SLEEPHQ_BASE_URL` | Optional SleepHQ API host override for testing; defaults to `https://sleephq.com`. |
| `LIFEOS_SIMPLEFIN_ACCESS_URL` | SimpleFIN Bridge access URL (roadmap C0). This URL is itself a bearer credential (Basic Auth embedded in it) — provisioned via the guards vault, never logged, never stored on any record. Missing it is a `skipped` execution receipt, never a crash. Pulled only by an operator running `python -m domains.money.simplefin_ingest`; never scheduled. |

## Document blobs (ADR 015)

Uploaded documents keep their bytes and extracted text on the box, under the
`lifeos-blobs` volume — never in `entity.attributes`, because attributes are
full-text indexed and erased only per entity. Two operator consequences:

- **The nightly encrypted recovery bundle includes these files.** It contains
  both the `public` database schema and a read-only tar snapshot of this volume.
  Keep the owner's original documents too: the two snapshots are taken in one
  workflow but are not a transactional snapshot across storage systems.
- **Erasure is not just a database write.** `POST /entities/{id}/forget` on a
  document unlinks its blobs as well; do not erase a document by any other
  route, and never restore an old volume snapshot over a live one — that would
  resurrect files an erasure destroyed.

## Bill extraction — the one job that sends a document off the box (ADR 016)

```bash
docker compose run --rm --no-deps api python -m domains.bills.extract            # sweep
docker compose run --rm --no-deps api python -m domains.bills.extract <doc-id>   # one document
```

**This sends the full extracted text of a captured document to the Anthropic
Messages API** — for a medical bill, that is the patient's name, provider, dates
of service, codes and amounts. Nothing else in the system does that, and nothing
does it automatically: an upload never triggers it, and it is deliberately
**not** on the cron schedule. Run it when you mean to.

Every run leaves an audit trail on both sides: an `execution_receipt` like any
other job — deliberately carrying only the job name and status, since receipts
live in the model-readable `ops` domain — plus a `bill_extraction` entity per
document recording which document (id + sha256), which model, when, how many
characters were sent and what came back. Those records carry no PII and survive
the erasure of the bills they produced, so "was this document ever sent to
Anthropic?" stays answerable: `find(ctx, type_name="bill_extraction")`.

A run that transmitted and then failed is recorded as `status: "failed"`, and
that document then drops out of the no-argument sweep — retrying it is
deliberately an explicit `python -m domains.bills.extract <doc-id>`, so a
transient error never turns into an automatic second send of a medical bill.

What comes back are **candidates**, not facts: `status: "candidate"`,
`method: "llm_extraction"`, confidence below 1.0. Do not treat a `bill` as money
owed until the verifier below has promoted it.

Erasing a bill is `POST /entities/{id}/forget` like any other entity; erasing the
document it came from is the document path above. Erasing one does not erase the
other, and a re-run over a still-present document will not re-write an erased
candidate's fields.

## Bill verification — what turns a candidate into a fact (ADR 017)

**One-time, per environment, before the first run** (the type registry has no
redefinition path, so an existing database still holds C2's schemas):

```bash
docker compose run --rm --no-deps api python -m scripts.migrate_bill_status_verified
```

Then:

```bash
docker compose run --rm --no-deps api python -m domains.bills.verify            # sweep
docker compose run --rm --no-deps api python -m domains.bills.verify <doc-id>   # one document
```

**This sends nothing anywhere and uses no model.** It reads the candidates
derived from a document, does arithmetic on them — line items against the stated
total, the EOB's `plan_paid + patient_resp == allowed` per line, `allowed <=
billed`, coherent dates, duplicate line items, one currency, nothing still
flagged low-confidence, and a bill agreeing with its EOB on what the patient owes
— and records a `verification_receipt` per document naming which check said what
about which candidate. Money is compared as decimal within one cent.

A candidate is promoted to `status: "verified"` only when **every** check on it
passes; anything else stays a `candidate` and the receipt says what failed. A
failing candidate is a normal result, not a failed run — the job exits 0.

Safe to re-run at any time, and worth re-running after anything changes: it emits
zero events when the ruling is unchanged, and it demotes anything that has
stopped passing.

`status: "verified"` cannot be set by hand: `POST /capture` refuses it on a
`bill`/`eob`, refuses to edit a record that already carries it, refuses any
payload carrying a bills identity key under some other type name, and refuses to
write a `verification_receipt`, a `bill_extraction`, an `action_proposal` or an
`authority_receipt` at all. To correct a verified bill, erase it (or re-extract)
and verify again.

**Erasing a bill or EOB is `POST /entities/{id}/forget`, the same one endpoint,
and it now clears more than the record.** A verification receipt holds numbers
derived from the bill's amounts, and a difference equals an amount whenever the
other operand is zero — so the route redacts `checks` on every receipt naming
that record too, in live state and in event payloads. It does the same to
`draft_digest` on every authority receipt naming it (ADR 018), which also
revokes any approval resting on that text. The response carries
`receipts_redacted`; do not erase a bill by any other route.

Two counters on the report line mean look, not shrug: `errors` is a document the
run could not judge, and `invalid` is a record whose stored state no longer
matches its own type — which normally means something merged a foreign field onto
it. Both exit non-zero.

## Dispute drafts — proposed, never sent (ADR 018)

**One-time, per environment, before the first run.** The two new types are
defined automatically, but `bill`/`eob` gain a character-class bound on their
dates and the registry has no redefinition path:

```bash
docker compose run --rm --no-deps api python -m scripts.migrate_bill_date_charset
```

Then:

```bash
docker compose run --rm --no-deps api python -m domains.bills.dispute            # sweep
docker compose run --rm --no-deps api python -m domains.bills.dispute <doc-id>   # one document
```

**This sends nothing anywhere, and nothing in lifeos can.** It turns a *failed*
`verification_receipt` into a `proposed` `action_proposal`: the ids, the failing
checks, and a count of what it is deliberately not stating. The letter itself is
never stored — it is rendered from the bill when you read it — so a bill you
erase takes its draft with it.

Review and decide over HTTP:

```bash
curl -s $API/action-proposals?state=proposed          # the drafts, rendered, each with a draft_digest
curl -s -XPOST $API/action-proposals/<id>/approve -d '{"draft_digest":"<the digest you were shown>"}'
curl -s -XPOST $API/action-proposals/<id>/reject -d '{}'
curl -s $API/action-proposals/<id>/draft              # the approved draft; 403/409 without authority
```

Approving mints an `authority_receipt` recording who approved, when, which
proposal, the digest of the exact text, and a grant good for seven days. The
digest is required and must be the one you were shown: if the bill changed
between reading and approving, the approval is refused rather than binding you
to text you never saw. `/draft` refuses — and writes nothing — unless a valid,
matching, unexpired receipt covers that exact text.

**The listing shows the letter only while a proposal is `proposed`.** Once you
have decided, `body` and `draft_digest` come back `null` and the draft is
available from `/draft` alone — one door, so a lapsed or mismatched grant cannot
be worked around by listing instead. Everything else about the proposal (state,
points, subject ids, the authority id) stays visible.

Approving requires the owner's own session: it is refused under any token
carrying a `scopes` claim, however wide, and the receipt's `granted_via` records
whether the identity was verified (`owner_session`) or the box was running with
auth off (`local_dev`).

Report-line counters: `undisputable` is a receipt that failed only on checks
about what *lifeos* could not read (never sent to a provider as an accusation),
`unreadable` is a receipt whose verdicts were erased or are knowingly partial
(`checks_truncated`), `held` is a proposal a human already decided, `withdrawn`
is one whose bill now reconciles. Only `errors` exits non-zero.

## Scheduled jobs (ADR 014)

Four CLIs, run in order once a day, each leaving an `execution_receipt`
entity (`ok` / `failed` / `skipped`; only `ok` exits 0):

```bash
docker compose run --rm --no-deps api python -m domains.calendar.ingest
docker compose run --rm --no-deps api python -m domains.calendar.autolink
docker compose run --rm --no-deps api python -m domains.cpap.ingest
docker compose run --rm --no-deps api python -m domains.ops.briefing
```

The schedule is **not** installed by a deploy — it is operator-installed on the
box (`deploy` user crontab + `~/lifeos/run-scheduled-jobs.sh`, both managed by
the `install-lifeos-cron.ps1` runbox script). A failing job never stops the next
one; the wrapper still exits non-zero. "Did the cron run?" is a query, not an
ssh session: `find(ctx, type_name="execution_receipt")`.

Note that every deploy re-renders `lifeos/.env`, so job-only variables
(`LIFEOS_ICS_URLS`, `LIFEOS_BRIEFING_TZ`, `LIFEOS_SLEEPHQ_CLIENT_ID`,
`LIFEOS_SLEEPHQ_CLIENT_SECRET`) belong in Infisical `prod` **and** in the
Deploy step's `printf`; `~/lifeos/.env.jobs` is the interim home the runbox
script writes.

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
   discovery URL and issuer `https://token.actions.githubusercontent.com`.
   The bound subject must be the exact string GitHub issues, which embeds
   immutable account/repo IDs:
   `repo:kgsmith19@64936641/lifeos@1311515887:ref:refs/heads/main`
   (audience `https://github.com/kgsmith19`, or leave audiences empty).
   Then add the identity to project `lifeos` (Access Control → Machine
   Identities) with the read-only Viewer role — membership is separate
   from the org-level identity — and copy the identity ID. If auth fails
   with "subject not allowed", decode the runner's OIDC token in a one-off
   workflow to see the live claims.
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

## Auth re-point to the platform IdP (m2-08)

`docs/planning/issues/m2-08-feat-lifeos-shell-integration.md` /
`docs/planning/05-e-lifeos.md` section 4 / ADR-03 (`hyperbolic-core`'s
`docs/archived/2026-08-16/planning-04-adrs.md`): LifeOS stops being its own login surface and
starts reading the session the `hyperbolic-core` Shell establishes. The
prod project referenced throughout this file (`vhbzblllaohuljtareza`) is
retired as the **auth** source — it keeps owning the LifeOS `Postgres`
database (ADR-04: "Postgres (Supabase lifeos project) | LifeOS | per-app |
... | unchanged; LifeOS keeps its own database"), only its Auth/JWKS stops
being what `api.auth.settings()` verifies against.

**This is an env re-point, not a code change** — `api/auth.py`'s
`settings()` already builds the issuer/JWKS URL from `LIFEOS_SUPABASE_URL`
and checks `sub` against `LIFEOS_OWNER_USER_ID`, both environment variables,
which is exactly what makes the migration below a value change rather than a
deploy of new verification logic [confirmed by re-running the full backend
test suite, including a new `tests/api/test_auth.py` migration-scenario
section, against this file completely unmodified]. Do not "helpfully"
rewrite `authenticate()` for this migration; the whole point of routing
identity through two env vars from the start (ADR 008) was so this day
needs no code.

Step sequence (05-e section 4; execute 2-6 as one deploy train — step 2
before step 4 leaves a window where the OLD frontend cannot authenticate at
all, since its session was reading the OLD project's Auth):

1. **Create the owner user in the platform project's Auth**
   (`hyperbolic-core`'s toolbelt Supabase project, `woltgcggxaehtuypkxqk` —
   see `apps/toolbelt/docs/notes/2026-08-12-platform-idp-owner-setup.md` for
   the sibling procedure that already did this for the toolbelt's own
   owner-pinned RLS), sign-ups disabled, mirroring "One-time setup" step 1
   above. Record the new owner UUID — it is a **different** UUID from
   whatever `LIFEOS_OWNER_USER_ID` holds today, because it is a user in a
   different Supabase project's Auth.
2. **Backend re-point** (this repo's deploy env, Infisical `prod`): set
   `LIFEOS_SUPABASE_URL` to the platform project's URL and
   `LIFEOS_OWNER_USER_ID` to the UUID from step 1. Redeploy.
3. **Frontend re-point**: `VITE_SUPABASE_URL` /
   `VITE_SUPABASE_PUBLISHABLE_KEY` (`frontend/.env.example`) move to the
   platform project's public values — the same ones
   `apps/shell/frontend/src/lib/session.ts` already hardcodes as its default in the
   `hyperbolic-core` tree, since both zones read the one platform session
   (ADR-03; `docs/planning/05-a-hyperbolic-core.md` section 6).
4. **Session source swap**: the frontend stops calling `signInWithPassword`
   itself and reads the session `@hyperbolic/platform-client` already holds
   (same-origin `localStorage`, ADR-02) — see this issue's frontend
   changes: `frontend/src/lib/session.ts`, `frontend/src/App.tsx`.
5. **Delete the Login page** (`Login.tsx` + `Login.test.tsx`) and its
   route — done as part of this same change; an unauthenticated `/life/*`
   visit now does a full-document redirect to the Shell's `/login`.
6. **Re-mint agent/MCP tokens** (`mcp_server/tokens.py`'s self-issued agent
   token pattern) so their verification chain matches the platform project's
   JWKS rather than the retired one. **Not performed here** — see "What
   this sandbox could not do" below.
7. **Break-glass, already implemented, documented rather than built**:
   `LIFEOS_AUTH_MODE=disabled` — see the "Environment variables" table
   above. `api.auth.authenticate()` grants `AccessContext.all()` to any
   request without checking the network interface it arrived on; the actual
   "localhost only" guarantee this issue's LO-2e requires is NOT a property
   of this Python process, which cannot see which interface accepted the
   TCP connection — it comes from the deploy topology one layer down: the
   API container binds `127.0.0.1:8000` only (`docker-compose`, `EXPOSE
   8000` in `Dockerfile` is documentation, not a bind), and
   `docs/ops/tailscale-serve-apply.sh`'s `/life/api/` route is the only
   thing in front of it that can reach a non-loopback network at all. An
   operator who sets `LIFEOS_AUTH_MODE=disabled` on a box where something
   ELSE (a stray `--host 0.0.0.0`, a compose port mapping) exposes 8000
   beyond loopback has broken the deploy topology's own invariant, which
   this environment variable cannot detect or repair from inside the
   process — this file's "3. VPS" section and `docs/ops/runbook.md`'s `ss
   -tlnp` verification step are what an operator checks to confirm the
   topology actually holds. `disabled` is a local-dev/emergency-bypass
   value, never set in `prod`'s Infisical environment; `test_disabled_mode_allows_all`
   in `tests/api/test_auth.py` (unchanged by this issue) is what proves the
   Python-level half of this contract.

### What this sandbox could not do

No coding session here holds a real Supabase project-admin credential for
either the retiring `vhbzblllaohuljtareza` project or the platform
`woltgcggxaehtuypkxqk` project, and none of the four env vars above can be
set to a real value without one — the same category of limitation
`apps/toolbelt/docs/notes/2026-08-12-platform-idp-owner-setup.md` (m1-07)
documented for the platform project's own owner setup. Steps 1, 2, 3 and 6
above are recorded here as exact operator actions, not performed. What
**was** verified for real, in this sandbox, without needing those
credentials:

- The claim that this is an env re-point and not a code change:
  `tests/api/test_auth.py`'s existing suite (27 cases, unmodified by this
  issue) plus five new cases naming the migration scenario explicitly
  (`test_lo2c_stale_issuer_token_from_the_old_project_is_rejected` and
  siblings) — all against `api/auth.py` exactly as it read before this
  issue touched this repo.
- `LIFEOS_ROOT_PATH` / base-path mechanics: `tests/api/test_root_path.py`,
  a genuine before/after (a request carrying the `/life/api` prefix 404s
  with the variable unset, 200s once it is set — the one piece of THIS
  issue that is new backend behavior).
- The frontend no longer contains a local sign-in call:
  `grep -rn signInWithPassword frontend/src --include='*.ts*'` (LO-2b) —
  see the frontend section of this issue's report for the exact output.

## Deploys
Merge to `main` → `ci.yml`: checks (ruff, mypy, pytest against ephemeral
pgvector Postgres with all migrations applied) → image to GHCR (`:main` +
`:sha-<commit>`) → fetch prod secrets from Infisical via OIDC → migrations
via `supabase db push` → render + ship the VPS `.env` → compose pull/up over
Tailscale SSH → `/healthz` smoke check (verifies DB connectivity).

Rollback: on the VPS as `deploy` — edit the recorded image rather than
overriding it inline, so the scheduled-jobs cron (which reads the same
`.env`) follows the rollback too:
```bash
cd ~/lifeos && sed -i 's|^LIFEOS_IMAGE=.*|LIFEOS_IMAGE=ghcr.io/kgsmith19/lifeos:sha-<previous sha>|' .env && docker compose up -d
```
Database changes roll forward (append-only log); never down-migrate.

## Backups and restore drill
Nightly `backup.yml` builds one recovery bundle containing a `--schema=public`
PostgreSQL dump, the `/app/var/blobs` volume snapshot, and SHA-256 checksums.
It validates both archive formats before encrypting to the age public key and
keeps only the ciphertext artifact for 90 days.

Restore only into isolated targets. Never unpack a backup over the live blob
volume: an older archive can contain a file that a later erasure removed.
Quarterly, and before anything risky, download an artifact and run:
```bash
age -d -i lifeos-backup.key -o lifeos-backup.tar lifeos-backup-<run-id>.tar.age
mkdir lifeos-restore && tar -C lifeos-restore -xf lifeos-backup.tar
(cd lifeos-restore && sha256sum --check SHA256SUMS)

docker run -d --name lifeos-db-restore -e POSTGRES_PASSWORD=pg -p 5433:5432 pgvector/pgvector:pg17
until pg_isready -h 127.0.0.1 -p 5433 -U postgres; do sleep 1; done
psql postgresql://postgres:pg@localhost:5433/postgres -c 'create schema if not exists extensions; create extension vector with schema extensions'
pg_restore --exit-on-error --no-owner -d postgresql://postgres:pg@localhost:5433/postgres lifeos-restore/lifeos.dump
psql postgresql://postgres:pg@localhost:5433/postgres -c 'select count(*) from event'

docker volume create lifeos-blobs-restore-test
docker run --rm -i -v lifeos-blobs-restore-test:/restore alpine:3.22 \
  tar -C /restore -xf - < lifeos-restore/lifeos-blobs.tar
docker run --rm -v lifeos-blobs-restore-test:/restore:ro alpine:3.22 \
  find /restore -type f -print
```
Verify a sample of database `document.storage_ref` values against the isolated
volume before declaring the drill successful. Then remove the test container,
database, volume, and plaintext restore directory. A backup that has never been
restored is a hope, not a backup.

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
