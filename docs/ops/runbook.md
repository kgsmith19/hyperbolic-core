---
title: Platform Operations Runbook
status: active
owner: Kyle
updated: 2026-08-15
---

# Platform Operations Runbook

For what each third-party vendor does, how it's authenticated, and its cost, see
[`docs/ops/vendors.md`](vendors.md) — this runbook stays the authoritative source for exact
secret paths and operational procedures.

## VPS bootstrap (from nothing)

Every section below assumes a `deploy@$DEPLOY_HOST` that already exists, is
joined to the tailnet, and already trusts all three deploy keys (Shell,
Handler A, Brain). This section is that starting point, run once per VPS
(see `docs/planning/issues/m1-13-chore-platform-production-bootstrap.md`).

**One script**, run once as root on the fresh VPS, does steps 2-4 below --
creating the `deploy` user, generating and installing all three deploy
keypairs, and creating every directory `deploy.yml` expects to own:

```bash
# Preview every command it would run -- no mutation.
docs/ops/bootstrap-vps.sh --dry-run

# Also joins the tailnet first if you pass a reusable auth key
# (Settings -> Keys in the Tailscale admin console; omit to join yourself
# with `tailscale up` before running this).
sudo docs/ops/bootstrap-vps.sh --apply --tailnet-authkey=<tskey-...>
```

It prints the three PRIVATE key halves once at the end -- paste each
immediately into its Infisical path (see "Infisical and GitHub
configuration" below) and do not save them anywhere else; the script shreds
its own key files from disk before exiting. Rerunning is safe: it rotates
each key by name (replaces the matching `authorized_keys` entry) rather than
accumulating dead ones, so it also doubles as the key-rotation procedure.

Spelled out, what it does and why -- and the two steps it deliberately
leaves to you:

1. Provision one VPS and join it to the tailnet as an approved device
   (`tailscale up` -- the script's own `--tailnet-authkey` flag does this if
   given a reusable key; approve in the admin console if the ACL requires
   manual approval for non-`tag:ci` devices). **Not scriptable from inside
   the box**: the admin-console approval step, when the ACL requires it.
2. Create the `deploy` OS user: `useradd -m -s /bin/bash deploy` (skipped if
   it already exists).
3. Generate three deploy key pairs, one per pipeline (ADR-05's
   one-identity-per-pipeline rule extends to keys, not just Infisical
   identities): `ssh-keygen -t ed25519 -C <name>@hyperbolic-core -f <key>`,
   no passphrase (must be usable non-interactively from CI). Install each
   **public** half into `~deploy/.ssh/authorized_keys` (mode 600, directory
   mode 700, owned by `deploy`). The **private** halves are printed once,
   for you to paste into Infisical at `/platform/shell-deploy/SHELL_DEPLOY_SSH_KEY`,
   `/platform/llm-handler/LLM_HANDLER_SSH_KEY`, and `/brain/BRAIN_DEPLOY_SSH_KEY`
   -- never in this repository, never on a workstation disk longer than the
   copy takes.
4. Create the directories `deploy.yml` expects to own: `mkdir -p ~deploy/{shell,lifeos-ui,llm-handler,brain}`.
5. Confirm `ssh -o BatchMode=yes deploy@<tailnet-name> true` succeeds from a
   tailnet client before the first real CI dispatch; `deploy.yml`'s own
   `ssh_options` use `BatchMode=yes`, so a passphrase-protected or
   not-yet-trusted key fails the job immediately rather than hanging. **Not
   scriptable from inside the box being bootstrapped**: this has to run from
   a separate tailnet client, after step 1's admin-console approval (if any)
   has actually landed.

## Infisical and GitHub configuration

The one part of m1-13 with no API to script against without an account
first: creating the Infisical organization itself is a one-time web-console
signup, same as any other SaaS org. Everything after that is scriptable.

**Console, once** (`app.infisical.com`, or self-hosted):

1. Create a project for this repo (distinct from the standalone
   `kgsmith19/lifeos` repo's own separate Infisical project).
2. Create environment `prod`.
3. Create three GitHub-OIDC machine identities, one per pipeline that needs
   one beyond Shell/Handler A/Brain deploy (`shell-deploy`,
   `llm-handler-deploy`, `brain-deploy` already covered by the VPS keys
   above; add `platform-migrations` and `platform-backup`), each trusting
   this repo's OIDC subject (`repo:kgsmith19/hyperbolic-core:*`, or narrower
   per-environment/per-ref if the console offers it) and scoped by ACL to
   read only its own secret path below -- confirm that scoping in the
   console; it cannot be verified from this repository (see "Operator
   evidence still required" under Brain deployment).
4. Create the secret paths and set the non-VPS-key values by hand (PATs, the
   DB connection string, OAuth secrets -- material only you hold, that no
   script here can generate):

   | Path | Keys |
   | --- | --- |
   | `/platform/shell-deploy/` | `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, `SHELL_DEPLOY_SSH_KEY` (from the VPS script's output) |
   | `/platform/llm-handler/` | `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, `LLM_HANDLER_SSH_KEY` (from the VPS script's output), `TOOLBELT_GITHUB_INTAKE_PAT`, `SUPABASE_SERVICE_ROLE_KEY`, and optionally `LLM_KEYS_ANTHROPIC` / `LLM_KEYS_OPENAI` / `LLM_KEYS_GEMINI` (provider keys for the service's LLM routes; omitted from the rendered `.env` when absent) |
   | `/brain/` | `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, `BRAIN_DEPLOY_SSH_KEY` (from the VPS script's output), `BRAIN_ANTHROPIC_API_KEY` |
   | `/platform/` | `SUPABASE_DB_URL` (table-owner Postgres connection string -- read by `platform-migrations.yml`, which sets `secret-path: "/platform/"`) |
   | `/toolbelt/` | `SUPABASE_DB_URL` (same connection string, a second copy -- read by `platform-backup.yml`, which sets `secret-path: "/toolbelt/"`; the two pipelines deliberately read different paths so their identities' grants stay disjoint) |

**One script**, run once locally with `gh auth login` already done as an
account holding admin on the repo, sets every repository variable this
runbook's later sections reference, and (optionally) branch protection:

```bash
# Preview every `gh` call it would make -- no mutation.
docs/ops/bootstrap-github.sh --dry-run \
  --repo=kgsmith19/hyperbolic-core \
  --deploy-host=<tailnet-name> \
  --infisical-project-slug=<slug> \
  --infisical-shell-deploy-identity=<id> \
  --infisical-llm-handler-deploy-identity=<id> \
  --infisical-brain-deploy-identity=<id> \
  --infisical-platform-migrations-identity=<id> \
  --infisical-platform-backup-identity=<id> \
  --platform-age-public-key=<age1...>

# Run for real once the values above look right. Flip the go-live gates and
# require the PR Gate checks on main in the same pass, or leave them off
# and run this again later once you're actually ready to deploy.
docs/ops/bootstrap-github.sh --apply \
  --repo=kgsmith19/hyperbolic-core \
  --deploy-host=<tailnet-name> \
  --infisical-project-slug=<slug> \
  --infisical-shell-deploy-identity=<id> \
  --infisical-llm-handler-deploy-identity=<id> \
  --infisical-brain-deploy-identity=<id> \
  --infisical-platform-migrations-identity=<id> \
  --infisical-platform-backup-identity=<id> \
  --platform-age-public-key=<age1...> \
  --enable-deploy --enable-backup --branch-protection
```

`--enable-deploy`/`--enable-backup` are separate opt-in flags rather than
bundled into the identity-recording pass: recording where the secrets live
and actually flipping `deploy.yml`/`platform-backup.yml` live are different
decisions, and the script keeps them separable so a rerun to correct one
variable can't silently also go live. `--branch-protection` sets exactly
this issue's own acceptance criterion (`Toolbelt PR Gate`, `ACC PR Gate`,
`Shell PR Gate` required on `main`); GitHub's branch-protection API replaces
the whole rule on every call, so this is safe to rerun but will overwrite
any protection settings configured by hand outside this script.

Once both scripts have run, the one remaining action name a placeholder in
this runbook can't stand in for is `TOOLBELT_OWNER_TOKEN`: set it once
m1-07's owner setup produces a real owner access token (`12-risk-register.md`
section 5's Out-of-Brief Register has the full writeup of why
`toolbelt-ci.yml` needs it).

## Single-origin Tailscale Serve routes

The VPS exposes one tailnet-only HTTPS origin. Tailscale provides the network boundary; applications still enforce authentication and authorization.

| Path | Target | State |
| --- | --- | --- |
| `/` | `/home/deploy/shell/current` | active static bundle |
| `/life/` | `/home/deploy/lifeos-ui/current` | active static bundle (versioned dirs + symlink, activated by `lifeos-deploy.yml`) |
| `/life/api/` | `http://127.0.0.1:8000` | active loopback proxy |
| `/api/` | `http://127.0.0.1:8200` | active loopback proxy (Handler A; `/api/intake/submit` and `/api/v1/complete`\|`stream`\|`count`, m4-05) |
| `/api/brain/` | `http://127.0.0.1:8100` | active loopback proxy (the Brain daemon; full-path forwarding matches `server.ts`'s `/api/brain/*` routes) |

The command shape follows the current [Tailscale Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve). Apply the routes by dispatching the **`Ops Serve Apply`** workflow (`.github/workflows/ops-serve-apply.yml`) from the Actions tab -- it ships the exact checked-in script over keyless Tailscale SSH, runs it with `--apply`, and republishes `tailscale serve status` before and after to the run summary. Gated on `DEPLOY_ENABLED`, same as every prod-touching job. The script can still be run directly on the VPS when working on the box itself:

Do not apply these routes until the LifeOS m2-08 base-path release and Handler A (`llm-handler`, see "Handler A deployment" below) are both deployed. The script proves the built LifeOS asset URLs use `/life/`, and that both the LifeOS and Handler A loopback `/healthz` endpoints respond, before it changes any route.

```bash
# Inspect the exact commands. This is the default and performs no writes.
docs/ops/tailscale-serve-apply.sh --dry-run

# Apply the three active mappings after all preflights pass.
docs/ops/tailscale-serve-apply.sh --apply
```

Reapplying the same mappings is idempotent. The script intentionally does not call `tailscale serve reset`, because that would delete unrelated configuration without a recoverable transaction. It prints `tailscale serve status` after applying; the operator must investigate and explicitly remove any unexpected pre-existing mappings.

### Verify

From a tailnet client, replace `<origin>` with the node's tailnet HTTPS name:

```bash
test "$(curl -fsS https://<origin>/healthz)" = '{"status":"ok"}'
curl -fsS -o /dev/null https://<origin>/life/
curl -fsS -o /dev/null https://<origin>/life/api/healthz
```

On the VPS:

```bash
tailscale serve status
ss -tlnp
```

The Shell is static. LifeOS and future services must listen only on loopback; investigate any application listener on a non-loopback interface.

### Remove one mapping

Use the same protocol, port, and path flags with `off`, then inspect status:

```bash
tailscale serve --bg --yes --https=443 --set-path=/life/api/ off
tailscale serve status
```

Rerun `--apply` to restore the declared active mappings. Reserve `tailscale serve reset` for an intentional full rebuild after capturing `tailscale serve status --json` and confirming every affected route.

### Operator evidence still required

This repository verifies command generation and the Shell's real static `/healthz` asset in CI. It cannot prove the live tailnet, VPS listeners, release directories, TLS, or LifeOS upstream. Record the apply output, status, three client checks, and `ss -tlnp` result when the operator rollout occurs.

## Shell deployment

`.github/workflows/deploy.yml` deploys from `main` only. Both the build and deploy jobs require repository variable `DEPLOY_ENABLED` to equal `true`; database migrations remain independently gated by their owner and ledger preflights.

Configure these repository variables before enabling deployment:

| Variable | Purpose |
| --- | --- |
| `DEPLOY_ENABLED` | Literal `true` enables Shell build and deployment. |
| `DEPLOY_HOST` | Tailnet DNS name used for SSH and HTTPS health verification. |
| `INFISICAL_PROJECT_SLUG` | Infisical project containing the least-privilege `/platform/shell-deploy/` path. |
| `INFISICAL_SHELL_DEPLOY_IDENTITY_ID` | Dedicated OIDC identity for this pipeline. |

`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_ACC_API`, and `VITE_LIFEOS_API` are optional public overrides; the Shell has documented production defaults.

The `shell-deploy` OIDC identity's `/platform/shell-deploy/` secret path must contain three values: `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET` (the tailnet join, shared shape with every other CI-joining workflow) and `SHELL_DEPLOY_SSH_KEY` (the deploy user's private key, PEM/OpenSSH text; `deploy.yml` writes it to the runner's default SSH identity path before the first `ssh`/`scp` call -- see "VPS bootstrap" above for how the matching public half gets installed).

The deploy job uploads into a run-specific staging directory, atomically switches `shell/current`, and verifies both `/healthz` and the built JavaScript asset through the real tailnet origin. A failed activation or health proof restores the previous symlink automatically. Only after health succeeds does `prune-dist-dirs.sh` retain the newest three releases.

A manual `Platform Deploy` dispatch defaults to deploying Shell without touching the database. Set `apply_migrations: true` only when the pending migration set has been reviewed and the owner/ledger preflights are expected to pass; this remains main-only and runs before Shell activation. `deploy_shell` can be disabled for an explicit migration-only dispatch.

Manual rollback remains available without a rebuild:

```bash
ssh deploy@<host> 'ln -s dist-<prior-sha> shell/current.rollback && mv -Tf shell/current.rollback shell/current'
test "$(curl -fsS https://<origin>/healthz)" = '{"status":"ok"}'
```

Record the workflow URL, deployed commit, health output, and rollback rehearsal. Live SSH, Infisical, tailnet ACL, and host behavior cannot be proven by repository tests.

## Handler A deployment

`services/llm-handler` is Handler A (08-llm-handlers.md forced decisions 5/7) -- the deployable-unit skeleton pulled forward by m3-06 to host Idea Intake's submit API ahead of its own M4 milestone (m4-05). Unlike Shell, it is a real container, not a static bundle: `.github/workflows/deploy.yml`'s `build-llm-handler`/`deploy-llm-handler` jobs follow the exact same shape as LifeOS's own backend deploy (`apps/lifeos/.github/workflows/ci.yml`) -- build and push to `ghcr.io/kgsmith19/hyperbolic-core/llm-handler`, then `docker pull`/`save`/`ssh`/`load` onto the VPS, which holds no registry credentials of its own.

Configure these repository variables in addition to Shell's own (`DEPLOY_ENABLED`, `DEPLOY_HOST`, `INFISICAL_PROJECT_SLUG` are shared):

| Variable | Purpose |
| --- | --- |
| `INFISICAL_LLM_HANDLER_DEPLOY_IDENTITY_ID` | Dedicated OIDC identity for this pipeline (ADR-05: never `shell-deploy`'s identity, even though both ultimately reach the same `deploy` OS user). |

The `llm-handler-deploy` identity's `/platform/llm-handler/` secret path must contain five values: `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` (tailnet join, shared shape with every other CI-joining workflow), `LLM_HANDLER_SSH_KEY` (a distinct deploy key from Shell's own -- generate its own pair in the "VPS bootstrap" steps below, do not reuse `SHELL_DEPLOY_SSH_KEY`), `TOOLBELT_GITHUB_INTAKE_PAT` (05-h-idea-intake.md section 6.3 -- a fine-grained GitHub PAT scoped to `Issues: Read and write` on the explicitly selected target repos, nothing else), and `SUPABASE_SERVICE_ROLE_KEY`. Optionally it also carries `LLM_KEYS_ANTHROPIC` / `LLM_KEYS_OPENAI` / `LLM_KEYS_GEMINI` -- the provider keys behind the service's `/api/v1/*` LLM routes (`services/llm-handler/src/config.ts` treats each as optional; the deploy omits an absent key from `.env` rather than failing, so the routes for an unprovisioned provider simply stay credential-less).

`SUPABASE_SERVICE_ROLE_KEY` deserves the same care as platform-migrations' `SUPABASE_DB_URL`: it bypasses RLS entirely. Handler A holds it for exactly one purpose -- calling `intake.mark_submitted_to_github()`, the narrow SECURITY DEFINER RPC that is the only legal way to complete a submit (`20260814040000_intake_mark_submitted_to_github_rpc.sql`; a plain PostgREST PATCH is blocked at the grant level by design, closing a P1 finding from the PR #8 security review). The service never uses this key for anything else and never derives it from an incoming request; every other database read/write in `services/llm-handler` rides the caller's own session JWT through PostgREST, scoped by the same `owner_rw` RLS the browser would get directly. Deliberately kept in its own path, not co-located with `/platform/`'s `SUPABASE_DB_URL` (platform-migrations' own credential) -- two different powerful secrets serving two unrelated pipelines should never share one Infisical grant.

`SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are not secrets: the deploy job reads them from the same public repository variables Shell's build already uses (`vars.VITE_SUPABASE_URL`, `vars.VITE_SUPABASE_PUBLISHABLE_KEY`).

Extend the "VPS bootstrap" steps above with Handler A's own key pair: generate a second `ssh-keygen -t ed25519` pair, install its public half into the SAME `~deploy/.ssh/authorized_keys` (one OS user, multiple trusted keys is normal), store the private half at `/platform/llm-handler/LLM_HANDLER_SSH_KEY`, and `mkdir -p ~deploy/llm-handler`.

Manual rollback mirrors LifeOS's own container rollback: repoint the image tag and restart.

```bash
ssh deploy@<host> 'cd llm-handler && sed -i "s#^LLM_HANDLER_IMAGE=.*#LLM_HANDLER_IMAGE=ghcr.io/kgsmith19/hyperbolic-core/llm-handler:sha-<prior-sha>#" .env && docker compose up -d --wait'
test "$(curl -fsS https://<origin>/api/healthz)" = '{"status":"ok"}'
```

Record the workflow URL, deployed commit, health output, and rollback rehearsal, same as Shell. Live SSH, Infisical, tailnet ACL, and host behavior cannot be proven by repository tests.

## Brain deployment

`services/brain` is the Brain daemon (07-brain-architecture.md; `docs/planning/10-cicd-deployment.md` section 2.3). Like Handler A, it is a real container: `.github/workflows/deploy.yml`'s `build-brain`/`deploy-brain` jobs follow the exact same shape as Handler A's own deploy (build and push to `ghcr.io/kgsmith19/hyperbolic-core/brain`, then `docker pull`/`save`/`ssh`/`load` onto the VPS), in its own `brain/` compose project directory, entirely separate from `lifeos/` and `llm-handler/`.

Configure these repository variables in addition to Shell's own (`DEPLOY_ENABLED`, `DEPLOY_HOST`, `INFISICAL_PROJECT_SLUG` are shared):

| Variable | Purpose |
| --- | --- |
| `INFISICAL_BRAIN_DEPLOY_IDENTITY_ID` | Dedicated OIDC identity for this pipeline (ADR-05: never `shell-deploy`'s or `llm-handler-deploy`'s identity, even though all three ultimately reach the same `deploy` OS user). |

The `brain-deploy` identity's `/brain/` secret path (ADR-05's own path convention -- never `/platform/brain-deploy/` or any path under `/platform/`, since the Brain's own key is isolated from every other unit's secrets by construction, not just by naming) must contain: `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` (tailnet join, shared shape with every other CI-joining workflow), `BRAIN_DEPLOY_SSH_KEY` (a distinct deploy key from Shell's and Handler A's own -- generate its own pair in the "VPS bootstrap" steps below), and `BRAIN_ANTHROPIC_API_KEY` (the Brain's own metered Anthropic API key -- 07-brain-architecture.md's own gate question 1: harness dispatch on the VPS authenticates with this key, not the operator's subscription session). Optionally also `SUPABASE_SERVICE_ROLE_KEY` (m4-17's core-mirror write-back; the daemon runs and passes its health check without it, just skips mirroring cost/telemetry rows) and, once a task class is wired to use it (m4-20's stubbed `LifeOsSurface` client), `BRAIN_AGENT_TOKEN_PUBLIC_KEY` / `BRAIN_AGENT_TOKEN_ISSUER` / `BRAIN_AGENT_TOKEN_AUDIENCE` (verifies LifeOS-minted agent tokens calling into the Brain's own `/api/brain/*` surface) and `BRAIN_LIFEOS_API_URL` / `BRAIN_LIFEOS_AGENT_TOKEN` (the Brain calling out to LifeOS). All of these are optional at the daemon's own boot (`config.ts` has no required field); the deploy job passes through whatever Infisical provides and omits the rest from the rendered `.env` rather than failing.

`BRAIN_ANTHROPIC_API_KEY` is the one value the deploy job hard-requires (`test -n`) before rendering anything: `services/brain/compose.yaml`'s own `secrets:` block references a file that must exist for `docker compose up` to succeed at all, regardless of whether any task has exercised it yet. It is rendered to its own file (`brain/anthropic-api-key`, mode 600) and mounted into the container at `/run/secrets/anthropic-api-key` (Docker Compose's own secrets convention) -- the rendered `.env` sets `BRAIN_SECRET_FILE=/run/secrets/anthropic-api-key` to match, ADR-05's key-isolation mechanism (`isolation-check.mjs`'s own header comment: "the standard Docker/Compose secrets-mount convention"). `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are not secrets: the deploy job reads them from the same public repository variables Shell's and Handler A's builds already use (`vars.VITE_SUPABASE_URL`, `vars.VITE_SUPABASE_PUBLISHABLE_KEY`).

Extend the "VPS bootstrap" steps above with the Brain's own key pair: generate a third `ssh-keygen -t ed25519` pair, install its public half into the SAME `~deploy/.ssh/authorized_keys`, store the private half at `/brain/BRAIN_DEPLOY_SSH_KEY`, and `mkdir -p ~deploy/brain`.

Manual rollback mirrors Handler A's own container rollback: repoint the image tag and restart.

```bash
ssh deploy@<host> 'cd brain && sed -i "s#^BRAIN_IMAGE=.*#BRAIN_IMAGE=ghcr.io/kgsmith19/hyperbolic-core/brain:sha-<prior-sha>#" .env && docker compose up -d --wait'
ssh deploy@<host> 'curl -fsS http://127.0.0.1:8100/healthz'
```

Verified over the loopback via ssh, matching exactly what `deploy-brain`'s own health-gate step checks -- not through the public tailnet origin. See "Operator evidence still required" immediately below for why.

Brain state (SQLite WAL, run journal) lives entirely in the `brain-state` compose volume, never inside the image, so an image rollback never touches run history -- the same guarantee 10-cicd-deployment.md section 8.3 states for the standalone lifeos stack's own image rollback.

### Operator evidence still required (ADR-05 identity isolation)

This repository proves, in `docs/ops/deploy-workflow.test.mjs`, that `deploy-brain` and `deploy-llm-handler` are structurally disjoint: distinct Infisical secret paths (`/brain/` vs `/platform/llm-handler/`), distinct SSH key variables, distinct compose project directories, and distinct `concurrency` groups. It cannot prove the live Infisical project itself actually scopes the `brain-deploy` machine identity's ACL to read only `/brain/` (and `llm-handler-deploy`'s to read only `/platform/llm-handler/`) -- that is Infisical-side configuration, external to this repository, the same category of gap the tailscale-serve section above already names. When provisioning each identity, confirm in the Infisical console that its ACL grants read access to exactly its own path and no other, and record that confirmation here. `brain-ci.yml`'s own "ADR-05 isolation check" PR-gate step proves the narrower, code-side half of this guarantee on every PR: the Brain's secret file is unreadable from an ordinary (non-Brain-container) process, by construction.

### Brain external reachability: `/api/brain/` mount

`services/brain/src/server.ts` registers its HTTP surface under `/api/brain/*` plus a bare `/healthz` for the in-container Docker healthcheck. The serve mount is `/api/brain/` -- tailscale forwards the full incoming path unchanged (the same mechanic as `/api/` and `/life/api/`), so `https://<origin>/api/brain/<route>` reaches the container as `/api/brain/<route>`, exactly what the server handles. (The original mount was `/brain/stream`, a name that predated the server's real route shape; nothing handled that path, so it was retired when the mount was corrected -- issue #134.) The `/api/brain/` mount is more specific than `/api/`, and Tailscale Serve routes by most-specific path, so Handler A keeps everything else under `/api/`. External health probes use `/api/brain/health` (unauthenticated), never the origin's bare `/healthz`, which is the Shell's static health asset.

## Release tagging (issue #189)

Every unit that deploys and passes the post-deploy smoke verdict gets a durable git tag: `deploy/<unit>/<yyyymmdd>-<shortsha>` (UTC date, first 12 hex characters of the deployed commit). Units: `shell`, `llm-handler`, `brain` (from `deploy.yml`'s own `tag-release` job) and `lifeos-backend`, `lifeos-ui` (from `lifeos-deploy.yml`'s own `tag-release` job). Query them with `git tag -l 'deploy/shell/*'` or via the GitHub UI's tag list -- there was no queryable release history before this landed.

The tagging job runs last, `needs` every deploy job in its file plus `smoke`, and only fires once `needs.smoke.result == 'success'` -- not merely because an individual unit's own deploy job succeeded. A unit's deploy job succeeding but the run's overall smoke failing means something is wrong with the live result even if that one container came up cleanly, so no tag is created for anyone that run. A deploy job that internally rolled back to its previous release still reports its own job result as `failure` (GitHub Actions marks a job failed once any step fails, even when a later `if: failure()` rollback step recovers cleanly) -- so per-unit tagging naturally skips a rolled-back unit too, with no extra rollback-detection logic needed beyond checking the job's own result.

Tagging is idempotent: re-running a deploy for a unit that already has today's tag (e.g. a second push same day) checks for the exact tag name via the GitHub API first and skips creating it again rather than erroring or overwriting. The tagging logic itself lives in one shared script, `docs/ops/tag-release.sh` (`docs/ops/tag-release.test.mjs` exercises it against a faked GitHub API, not a real network call), called once per unit from each workflow's own job -- the tag format and idempotency check exist in exactly one place, not duplicated between `deploy.yml` and `lifeos-deploy.yml`.

`contents: write` is granted only on the `tag-release` job in each file -- nowhere else in either workflow needs it, and every other job stays read-only. No new secret or Infisical path: tagging authenticates with the workflow's own ambient `GITHUB_TOKEN` (`permissions: contents: write` is sufficient to create a tag ref via the Git Data API).

## LifeOS cutover: standalone repo to monorepo

The standalone `kgsmith19/lifeos` repository ran the live LifeOS pipeline
until this cutover; the monorepo's `lifeos-deploy.yml`, `lifeos-backup.yml`,
and `lifeos-ops.yml` land dark behind `LIFEOS_DEPLOY_ENABLED` /
`LIFEOS_BACKUP_ENABLED` precisely so that flipping ownership is one ordered,
reversible sequence with no window in which two pipelines write to the same
VPS. Execute the steps in this order; do not parallelize them.

**Prerequisites** (once, before step 1): Infisical machine identity for
`lifeos-deploy` with read on `/platform/lifeos-deploy/` only, the path
populated (`DATABASE_URL`, `LIFEOS_SUPABASE_URL`, `LIFEOS_OWNER_USER_ID`,
`TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, plus any optional job vars:
`ANTHROPIC_API_KEY`, `LIFEOS_ICS_URLS`, `LIFEOS_BRIEFING_TZ`, SleepHQ and
SimpleFIN credentials); repository variable
`INFISICAL_LIFEOS_DEPLOY_IDENTITY_ID`; a NEW age keypair with its public
half in repository variable `LIFEOS_AGE_PUBLIC_KEY` (never reuse the
standalone repo's or the platform pipeline's pair); and the tailnet ACL
granting `tag:ci` Tailscale-SSH to `deploy@<vps>` (already true if the
platform deploys use keyless SSH; the standalone LifeOS pipeline has always
used it).

1. **Stop the standalone writers.** In `kgsmith19/lifeos`, set repository
   variables `DEPLOY_ENABLED=false` and `BACKUP_ENABLED=false`.
2. **Confirm quiescence.** In the standalone repo's Actions tab, confirm no
   deploy or backup run is in flight (wait for any to finish). From this
   point the box has exactly zero writers.
3. **Arm the monorepo.** Here, set `LIFEOS_DEPLOY_ENABLED=true` and
   `LIFEOS_BACKUP_ENABLED=true`.
4. **Bootstrap deploy (one time).** Dispatch `lifeos-deploy.yml` with
   `skip_live_verify` checked: the `/life/` serve route still points at the
   standalone layout until the route table is re-applied, so the live-route
   verify cannot pass yet. This run creates `lifeos-ui/current` and starts
   the backend from the monorepo image.
5. **Re-apply the serve routes** so `/life/` serves `lifeos-ui/current`:
   dispatch the `Ops Serve Apply` workflow (route table above).
6. **Fully verified deploy.** Dispatch `lifeos-deploy.yml` again with
   defaults. Both units must go green, including the live `/life/` verify
   and the backend's `/healthz` gate. Then confirm from a tailnet device:
   `https://<host>/life/` renders and `https://<host>/life/api/healthz` is
   green.
7. **First monorepo backup.** Dispatch `lifeos-backup.yml`; download the
   artifact and confirm it decrypts with the NEW LifeOS age key and lists
   (`age -d -i <key> | tar -t`).
8. **Cron ownership.** Dispatch `lifeos-ops.yml` task
   `install-scheduled-jobs` (rewrites the wrapper to the monorepo-managed
   text), then task `run-scheduled-jobs` once and confirm the trio passes.
9. **Record the cutover** on the Epic: run links for steps 4-8 and the
   owner's attestation that step 1's flips are in place.

**Rollback to the standalone pipeline** (if anything above fails and cannot
be fixed forward): set this repo's two `LIFEOS_*_ENABLED` vars back to
unset/false, re-point the `/life/` serve route at `lifeos-ui/dist`, and
restore `DEPLOY_ENABLED`/`BACKUP_ENABLED` in `kgsmith19/lifeos`. The
standalone pipeline's next deploy rebuilds its own layout; nothing the
monorepo shipped blocks it. Leave the standalone repository intact as
history in either outcome -- it is the archive of record for the pre-cutover
era, never deleted.

## One-time platform migration adoption

`platform-migrations.yml` authenticates to Infisical the same way `deploy.yml` does, via a dedicated OIDC identity: set repository variables `INFISICAL_PROJECT_SLUG` (shared with the Shell deploy pipeline) and `INFISICAL_PLATFORM_MIGRATIONS_IDENTITY_ID` (its own identity, scoped to `/platform/` only -- the path `platform-migrations.yml` actually sets as `secret-path` -- per ADR-05's one-identity-per-pipeline rule; never the same identity `shell-deploy` uses). Its `/platform/` secret path must contain `SUPABASE_DB_URL`, a table-owner-privileged Postgres connection string for the platform project; this is the single most powerful credential in either pipeline, since it bypasses RLS entirely. Without these two variables set, every dispatch fails immediately at the Infisical step, before touching the database at all.

The platform project predates the Supabase CLI ledger. Run the explicit `baseline_legacy_ledger: true` dispatch from `main`. It accepts only an empty ledger or an exact ordered prefix of the 18 reviewed legacy versions plus the two S1 versions, and it requires an empty schema diff plus explicit legacy seed/grant/extension/job checks before repairing any missing metadata. It then resumes the additive `platform` owner bootstrap and `test` fence (S1) and stops. If a run is interrupted after ledger repair or during S1, rerun the same baseline mode; a divergent/non-prefix ledger remains a hard stop.

Next, follow `apps/toolbelt/docs/notes/2026-08-12-platform-idp-owner-setup.md`: create the owner, insert the single `platform.config` row, and configure the owner CI credential (S2/S3). A normal migration dispatch then refuses to continue unless exactly one owner is present, applies the remaining forward migrations once, and runs the live platform contract. Never use baseline mode to repair a divergent or post-S1 ledger; investigate any attached schema diff instead of repairing around it.

## Platform project backup and restore

`platform-backup.yml` (m6-03, `docs/planning/10-cicd-deployment.md` sections 8.4/9) produces an age-encrypted recovery bundle of the platform Supabase project's (woltgcggxaehtuypkxqk) own schemas -- `platform`, `core`, `idea`, `prompt`, `intake`, every schema that carries real operator data -- daily on a schedule and on demand via `workflow_dispatch`. It extends the pattern already proven in the LifeOS standalone pipeline (`apps/lifeos/.github/workflows/backup.yml` -- inert here, that pipeline runs only from the standalone kgsmith19/lifeos repo) to a second target. `test` (a CI-only fence schema, `06-supabase-schema.md`) and the Supabase-managed schemas (`auth`, `storage`, `realtime`) are deliberately excluded: the platform restores those itself, and a restore must not replay them.

Setup, one time. Configure these repository variables before enabling it:

| Variable | Purpose |
| --- | --- |
| `INFISICAL_PLATFORM_BACKUP_IDENTITY_ID` | Dedicated OIDC identity for this pipeline (ADR-05's one-identity-per-pipeline rule -- never `INFISICAL_PLATFORM_MIGRATIONS_IDENTITY_ID`; the backup reads `/toolbelt/`'s `SUPABASE_DB_URL` while migrations read `/platform/`'s own copy, so the grants never overlap, and a compromised backup identity should not also be able to apply migrations, and vice versa). |
| `PLATFORM_AGE_PUBLIC_KEY` | An `age1...` recipient whose matching private identity is held offline and never stored in GitHub or Infisical. Deliberately a distinct repository variable from the (inert) LifeOS pipeline's own `AGE_PUBLIC_KEY`, so the two pipelines never share a key pair even if the LifeOS workflow is ever activated from this repo. |
| `PLATFORM_BACKUP_ENABLED` | Set to `true` once the identity and key above are provisioned; the job's whole `bundle` step is skipped otherwise. |

CI can create a bundle and can never open one; that asymmetry is deliberate, so a compromised runner cannot read the data it just backed up.

**restic primary (issue #166), gated separately from the age path above.** The age->GitHub-artifact
path is unconditional and always runs once `PLATFORM_BACKUP_ENABLED` is on; restic backup to the
Hetzner Storage Box is an additional, independently gated step using the same dump. Configure these
before flipping the gate:

| Variable | Purpose |
| --- | --- |
| `INFISICAL_PLATFORM_RESTIC_IDENTITY_ID` | A second, dedicated OIDC identity reading `/platform/backup/` -- never `INFISICAL_PLATFORM_BACKUP_IDENTITY_ID` above, which reads `/toolbelt/`'s `SUPABASE_DB_URL`. A compromised restic credential must not also unlock the database, and vice versa. `/platform/backup/` must contain `RESTIC_PASSWORD` and `STORAGEBOX_SSH_KEY` (see [`docs/ops/vendors.md`](vendors.md#infisical)). |
| `STORAGEBOX_HOST` / `STORAGEBOX_USER` | The Storage Box hostname and the `platform` repository's sub-account username (not secret -- same non-sensitive-fact pattern as `DEPLOY_HOST`). |
| `RESTIC_BACKUP_ENABLED` | Set to `true` once the Storage Box exists, the `platform` repository has been initialized (`docs/ops/restic-setup.sh`, [above](#hetzner-storage-box-bootstrap-restic)), and the identity/variables above are provisioned. Off by default; the age path is completely unaffected either way. |

The restic step reuses `docs/ops/restic-setup.sh --apply --repos=platform` to install/configure
before every run (idempotent -- a no-op once the repository already exists), then runs `restic
backup` against the same dump the age path just encrypted, `restic forget --keep-daily 7
--keep-weekly 4 --keep-monthly 6 --prune`, and asserts the new snapshot is listed before finishing.

The workflow verifies before it encrypts: the dump must be non-empty and must survive `pg_restore --list`, the `PLATFORM_AGE_PUBLIC_KEY` value must look like an `age1...` recipient (never an identity file), and the finished artifact's header must identify as `age-encryption.org`. A corrupt bundle fails the run rather than sitting in artifact storage looking like protection. Each bundle also carries `MIGRATION_LEDGER.txt`, the applied migration versions at snapshot time, because a restore has to know which migrations the snapshot already contains.

### The destructive-migration rule (referenced from `docs/planning/10-cicd-deployment.md` section 8.4)

A pull request containing a destructive platform migration -- any `drop table`, `drop column`, `drop schema`, `truncate`, destructive `alter column type`, or any migration whose down-path cannot restore the data it removes -- must cite the run id of a `platform-backup.yml` run that completed successfully **after** the PR's base commit. The run id is printed in that run's job summary (`.../actions/runs/<run_id>`). A destructive migration PR without a fresh backup run id is refused, and the reviewer is expected to refuse it on this rule rather than on judgment.

Recency matters more than existence here: a backup from before the base commit does not cover the rows the migration is about to remove. Dispatch a fresh `platform-backup.yml` run and cite that one. This is a process rule enforced at review, not (yet) a CI check; a future issue may add an automated PR-description grep for a run id pattern, out of m6-03's own scope.

### Restore drill

This is the manual procedure for the age-encrypted GitHub-artifact backup above. Once restic is live
(`RESTIC_BACKUP_ENABLED`), `ops-restore-drill.yml` (issue #168) runs an equivalent drill against both
restic repositories automatically, monthly and on demand -- see
["Restic restore drill (automated)"](#restic-restore-drill-automated) below. Run this manual
procedure against a scratch database, never the platform project. Record the date, the backup run id, and the row counts in the table below on each drill.

```bash
# 1. Download the artifact from the backup run, then decrypt with the offline identity.
age -d -i /path/to/offline-identity.txt \
  -o platform-backup.tar platform-backup-<run_id>.tar.age
tar -xf platform-backup.tar          # platform.dump, MIGRATION_LEDGER.txt, SHA256SUMS
sha256sum -c SHA256SUMS

# 2. Restore into a scratch database.
createdb platform_restore_drill
pg_restore --no-owner --no-privileges --dbname platform_restore_drill platform.dump

# 3. Compare row counts against the live project, and confirm the ledger matches.
for t in platform.config core.app core.run core.cost prompt.prompt idea.idea intake.idea; do
  echo -n "$t "
  psql platform_restore_drill -X -At -c "select count(*) from $t"
done
psql platform_restore_drill -X -At \
  -c "select version from supabase_migrations.schema_migrations order by version" \
  | diff - MIGRATION_LEDGER.txt && echo "ledger matches"

# 4. Tear down.
dropdb platform_restore_drill
```

| Drill date | Backup run id | core.app | core.run | core.cost | prompt.prompt | idea.idea | Ledger match | Operator |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| _not yet executed against a real platform-project artifact_ | | | | | | | | |

**Mechanism drill executed and recorded** (this session, m6-03; proves the drill procedure end to end, not a substitute for the table above -- this sandbox holds no live `SUPABASE_DB_URL` credential or offline age identity, so this drill ran the full pipeline for real against a local scratch Postgres 16 database seeded with representative rows, not the actual production project):

- Source (`core.app`: 2 rows, `idea.idea`: 2 rows) -> real `pg_dump --format=custom --no-owner --schema=core --schema=idea` (58,937 bytes) -> `pg_restore --list` verified a well-formed archive.
- Real `age -r <recipient>` encryption (59,137 bytes) -> `age -d -i <identity>` decryption reproduced a byte-identical dump (`cmp` confirmed) -> the encrypted artifact's first bytes matched the `age-encryption.org` header.
- `pg_restore --no-owner` into a fresh scratch database reproduced the exact source row counts: `core.app`: 2 rows, `idea.idea`: 2 rows.
- All scratch databases and the local age key pair were dropped/deleted immediately after; nothing from this drill was retained.

Executing the first drill against a real `platform-backup.yml` artifact and filling in the table above is an operator action requiring the offline age identity and live platform credentials, neither of which exists in a CI or agent environment by design -- it is the one acceptance criterion of m6-03 that repository changes cannot satisfy.

## Restic restore drill (automated)

`ops-restore-drill.yml` (issue #168, closes gap G-17 from the deployment research) runs monthly and
on demand once `RESTIC_BACKUP_ENABLED` is on. Unlike the manual age-based drill above, it needs no
operator: it runs entirely in the GitHub Actions runner, over SFTP straight to the Hetzner Storage
Box (no Tailscale join, no SSH to the VPS -- both restic repositories are reachable directly).

For each repository (`platform`, `lifeos`), in order:

1. `restic check --read-data-subset=10%` -- catches silent repository corruption before a real
   restore would ever need to find out the hard way.
2. Restore the latest snapshot into a scratch directory.
3. `pg_restore --list` verifies the restored dump archive is well-formed, then it is loaded into a
   throwaway Postgres 17 service container (the same job-level `services:` container both
   repositories share, torn down with the runner).
4. Row counts are asserted non-zero on a small set of real tables -- `platform.config`, `core.app`,
   `core.run`, `core.cost`, `prompt.prompt`, `idea.idea`, `intake.idea` for `platform` (the same set
   the manual drill above checks); `entity`, `type_definition`, `event`, `entity_type` for `lifeos`
   (the actual kernel tables from `apps/lifeos/backend/supabase/migrations/`, every domain record and
   event passes through `entity`/`event` -- there is no per-domain table to check instead).
5. For `lifeos` only: the restored blob directory's file count is asserted non-zero (a database-only
   check would miss a backup that silently stopped covering `/app/var/blobs`).

Results (pass/fail, snapshot id, every count) are written to the run's job summary regardless of
outcome. A failure in one repository's drill does not prevent the other's from running or from being
reported -- both are always attempted, and the job only fails at the very end if either one did.

## Hetzner Storage Box bootstrap (restic)

`docs/ops/restic-setup.sh` (issue #164) prepares the VPS to back up onto a Hetzner Storage Box via
restic. It is setup machinery only -- it installs a checksum-verified restic binary, writes the SSH
config alias the Storage Box's non-standard SFTP port needs, and idempotently `restic init`s the
`platform` and `lifeos` repositories. It does not run on a schedule and is not wired into any
workflow yet; `platform-backup.yml`/`lifeos-backup.yml` gain restic backup steps in #166/#167.

Owner steps, one time, before running it:

1. In the Hetzner Cloud console, purchase a Storage Box (BX11, ~€3.81/mo -- see
   [`docs/ops/vendors.md`](vendors.md#hetzner)).
2. Create two SFTP sub-accounts on the box, one per restic repository (`platform`, `lifeos`), each
   with its own home directory and its own SSH public key. Sub-account isolation means a compromised
   backup identity for one app cannot read or overwrite the other's snapshots.
3. Generate an SSH keypair per sub-account (or reuse one if the owner prefers a single credential --
   `restic-setup.sh --ssh-key-file=` accepts one key path per invocation). Store each private key and
   the shared `RESTIC_PASSWORD` (restic's own repository-encryption password, independent of the SSH
   key) under Infisical `/platform/backup/`, the path `platform-backup.yml`'s restic steps read from
   (see [`vendors.md`](vendors.md#infisical)'s Infisical path table).
4. Run the script once per box, from a host that already holds the SSH private key at 0600
   permissions:

   ```bash
   # Preview every command it would run -- no mutation.
   docs/ops/restic-setup.sh --storagebox-host=u123456.your-storagebox.de \
     --storagebox-user=u123456-sub1 --ssh-key-file=/path/to/key

   # Run for real once the plan looks right. RESTIC_PASSWORD must be set first.
   RESTIC_PASSWORD=... docs/ops/restic-setup.sh --apply \
     --storagebox-host=u123456.your-storagebox.de \
     --storagebox-user=u123456-sub1 --ssh-key-file=/path/to/key
   ```

   Re-running is safe: an already-installed matching restic version and an already-initialized
   repository are both detected and skipped rather than re-done.

Neither the SSH private key nor `RESTIC_PASSWORD` is ever written to disk by this script beyond the
key file the caller already placed -- both are read from the environment/an existing file and never
echoed or logged. The script has not been run against a real Storage Box yet: no box exists, so no
credentials exist for it to use. This is expected until the owner completes steps 1-3 above.

## Cloudflare edge origin (nginx + cloudflared)

`docs/ops/edge-origin/` (issue #165) is the local HTTP origin `cloudflared` (issue #169, added to
the same compose file) points at once the owner sets up Cloudflare Tunnel + Access. It is a second,
deliberately narrower front door onto the same box: `tailscale-serve-apply.sh`'s private route table
is untouched and keeps working exactly as before over the tailnet.

**Nothing is public by default.** `docs/ops/edge-origin/public_paths.conf` is the only place a path
can become reachable through this origin, and every line in the checked-in file is commented out --
`docs/ops/edge-origin.test.mjs` asserts this on every commit. With the file in that state, nginx has
no location block for any of the five private routes, so every request 404s; only `GET /healthz`
(defined directly in `nginx.conf`, not in `public_paths.conf`) ever answers, and it exists purely so
the container's own healthcheck has something stable to poll.

To expose a path: uncomment its `location` block in `public_paths.conf` and redeploy (`ops-edge.yml`
dispatch, or push a change under `docs/ops/edge-origin/`). Each block's target must mirror
`tailscale-serve-apply.sh`'s mount -> target mapping exactly (`edge-origin.test.mjs`'s sync test
fails the build if they ever drift apart), so copy the block as written rather than retyping it.

`nginx.conf` sets `access_log off;` -- deliberate for now, since with nothing exposed there is
nothing worth logging. Once a path is actually uncommented and this becomes cloudflared's real
public origin, revisit that line: Cloudflare Access/Tunnel logs the request at the edge, but if
nginx-side request logging is wanted too (e.g. to correlate against `docker logs` on the origin
containers), turn `access_log` back on at that point -- an explicit owner call, not made here.

### Deploying the stack (`ops-edge.yml`, issue #169)

Dark behind `CLOUDFLARE_EDGE_ENABLED` -- ships `compose.yml`/`nginx.conf`/`public_paths.conf` and a
rendered `.env` (holding only `CLOUDFLARE_TUNNEL_TOKEN`) to the box over keyless Tailscale SSH (ADR
008, no SSH key material), then `docker compose pull && docker compose up -d --wait`. Triggers on
`workflow_dispatch` or a push to `main` touching `docs/ops/edge-origin/**` (or the workflow file
itself, `.github/workflows/ops-edge.yml`).

Owner setup, one time, before flipping the gate:

| Variable | Purpose |
| --- | --- |
| `INFISICAL_PLATFORM_EDGE_IDENTITY_ID` | Dedicated OIDC identity reading `/platform/edge/` -- distinct from every other pipeline's identity (ADR-05); `/platform/edge/` must contain `CLOUDFLARE_TUNNEL_TOKEN` (from the Cloudflare dashboard when the tunnel is created). |
| `CLOUDFLARE_EDGE_ENABLED` | Set to `true` once the identity/token above are provisioned and a Cloudflare Tunnel exists pointed at this box. Off by default. |

Cloudflare dashboard steps (owner, one time): create a Tunnel, copy its token into
`/platform/edge/`'s `CLOUDFLARE_TUNNEL_TOKEN`, and set the tunnel's public hostname ingress rule to
`http://127.0.0.1:8081` (the edge-origin container) -- one blanket rule, not a per-path proxy;
per-path routing is entirely `public_paths.conf`'s job, never duplicated in the tunnel config. Access
policies (who may reach which public hostname/path) are #170, a separate dashboard step.

`docs/ops/edge-origin/compose.yml` pins `cloudflare/cloudflared:2025.6.1` -- **unverified against the
live registry** in the environment this was authored in (no network access to Docker Hub to confirm
the tag exists). Confirm or bump this tag before the first real deploy; a wrong tag fails loudly at
`docker compose pull` on the box, not silently.

### Verification once live (owner, manual)

Not automated in CI -- run once after the first real deploy, and after any change to the compose
stack:

```bash
# From a tailnet client (or the box itself): confirm cloudflared is genuinely
# outbound-only. Anything printed here besides existing loopback listeners
# (127.0.0.1:*, [::1]:*) and Tailscale's own listeners is a regression --
# the whole point of a tunnel is zero new inbound ports.
ssh deploy@<tailnet-name> "ss -tlnp"

# Confirm the box's firewall posture is unchanged (whatever it was before
# this deploy -- ufw status, or the absence of one, must match).
ssh deploy@<tailnet-name> "sudo ufw status 2>/dev/null || echo 'no ufw configured'"
```

Also confirm in the Cloudflare dashboard that the tunnel shows **Healthy**, and that a request to the
public hostname reaches `edge-origin` (a 404 for every path is correct until one is uncommented in
`public_paths.conf`).

### Cloudflare Access setup (issue #170)

Dashboard configuration, not code -- do this after the Cloudflare Tunnel itself is live and
reachable (issue #169) and before uncommenting any path in `public_paths.conf`. Every public hostname must
sit behind Access before it carries real traffic; there is no code-level enforcement of that
ordering, only this runbook.

1. **Identity provider.** Cloudflare Zero Trust dashboard -> Settings -> Authentication -> add a
   login method (Google Workspace, GitHub, one-time PIN, whichever the owner already uses
   elsewhere). One IdP is enough for a single-owner setup; add more only if additional people need
   access later.
2. **One Access application per public hostname.** Zero Trust dashboard -> Access -> Applications ->
   Add an application -> Self-hosted. Application domain = the exact public hostname the Tunnel
   serves (the same value that will go into the `CLOUDFLARE_PUBLIC_HOSTNAME` repository variable
   below). Do not scope the application to a sub-path here -- `public_paths.conf` already decides
   which paths exist at all; Access's job is "who may reach this hostname," not "which paths."
3. **Policy.** Include rule: the specific identity/identities allowed through (e.g. "Emails ending
   in @yourdomain.com", or a literal email allowlist for a single owner). Session duration: pick a
   value the owner is comfortable re-authenticating at (e.g. 24h) -- shorter is more secure, longer
   is more convenient; there is no code-level default to defer to here.
4. **Confirm, then flip the smoke gate.** Visit the public hostname in an incognito/logged-out
   browser -- it must redirect to a Cloudflare-hosted login page, never reach the app directly. Only
   once that's true, set the repository variable `CLOUDFLARE_PUBLIC_HOSTNAME` (the exact hostname
   from step 2) so `platform-smoke.yml`'s public-edge probe (below) starts asserting it on every
   deploy.

### Public-edge smoke check (`platform-smoke.yml`, issue #170)

Additive and independently gated -- the existing tailnet-private probes are completely unaffected by
this being on or off. Once `CLOUDFLARE_EDGE_ENABLED` and `CLOUDFLARE_PUBLIC_HOSTNAME` are both set,
every smoke run also sends one unauthenticated `GET` to `https://$CLOUDFLARE_PUBLIC_HOSTNAME/` and
asserts the response is a 3xx redirect (toward Access) -- never a 2xx (Access is not actually in
front of the app -- the exact regression this check exists to catch) and never a 5xx (the edge
itself is broken). The probe deliberately never follows the redirect (no `-L`): it confirms the
redirect happened, not what Access's own login page contains. The step's own gate is
`(success() || failure()) && vars.CLOUDFLARE_EDGE_ENABLED == 'true'`, not a bare variable check --
GitHub Actions implicitly ANDs a bare `if:` with `success()`, which would silently skip this probe
whenever the private-probe step above it fails, exactly when the public edge might also be broken.
