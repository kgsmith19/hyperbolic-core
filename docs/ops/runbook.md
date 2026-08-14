---
title: Platform Operations Runbook
status: active
owner: Kyle
updated: 2026-08-13
---

# Platform Operations Runbook

## VPS bootstrap (from nothing)

Every section below assumes a `deploy@$DEPLOY_HOST` that already exists, is
joined to the tailnet, and already trusts the deploy key. This section is
that starting point, run once per VPS (see
`docs/planning/issues/m1-13-chore-platform-production-bootstrap.md`).

1. Provision one VPS and join it to the tailnet as an approved device
   (`tailscale up`, approve in the admin console if the ACL requires manual
   approval for non-`tag:ci` devices).
2. Create the `deploy` OS user: `useradd -m -s /bin/bash deploy`.
3. Generate the deploy key pair (`ssh-keygen -t ed25519 -C deploy@hyperbolic-core -f deploy_key`,
   no passphrase -- it must be usable non-interactively from CI). Install the
   **public** half into `~deploy/.ssh/authorized_keys` (mode 600, directory
   mode 700, owned by `deploy`). Store the **private** half in Infisical at
   `/platform/shell-deploy/SHELL_DEPLOY_SSH_KEY` -- never in this repository,
   never on a workstation disk longer than the copy takes.
4. Create the directories `deploy.yml` expects to own: `mkdir -p ~deploy/shell ~deploy/lifeos-ui`.
5. Confirm `ssh -o BatchMode=yes deploy@<tailnet-name> true` succeeds from a
   tailnet client before the first real CI dispatch; `deploy.yml`'s own
   `ssh_options` use `BatchMode=yes`, so a passphrase-protected or
   not-yet-trusted key fails the job immediately rather than hanging.

## Single-origin Tailscale Serve routes

The VPS exposes one tailnet-only HTTPS origin. Tailscale provides the network boundary; applications still enforce authentication and authorization.

| Path | Target | State |
| --- | --- | --- |
| `/` | `/home/deploy/shell/current` | active static bundle |
| `/life/` | `/home/deploy/lifeos-ui/dist` | active static bundle |
| `/life/api/` | `http://127.0.0.1:8000` | active loopback proxy |
| `/api/` | `http://127.0.0.1:8200` | active loopback proxy (Handler A; `/api/intake/submit` and `/api/v1/complete`\|`stream`\|`count`, m4-05) |
| `/brain/stream` | `http://127.0.0.1:8100` | reserved; do not configure before the Brain exists |

The command shape follows the current [Tailscale Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve). Run the checked-in operator script on the VPS:

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

The `llm-handler-deploy` identity's `/platform/llm-handler/` secret path must contain five values: `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` (tailnet join, shared shape with every other CI-joining workflow), `LLM_HANDLER_SSH_KEY` (a distinct deploy key from Shell's own -- generate its own pair in the "VPS bootstrap" steps below, do not reuse `SHELL_DEPLOY_SSH_KEY`), `TOOLBELT_GITHUB_INTAKE_PAT` (05-h-idea-intake.md section 6.3 -- a fine-grained GitHub PAT scoped to `Issues: Read and write` on the explicitly selected target repos, nothing else), and `SUPABASE_SERVICE_ROLE_KEY`.

`SUPABASE_SERVICE_ROLE_KEY` deserves the same care as platform-migrations' `SUPABASE_DB_URL`: it bypasses RLS entirely. Handler A holds it for exactly one purpose -- calling `intake.mark_submitted_to_github()`, the narrow SECURITY DEFINER RPC that is the only legal way to complete a submit (`20260814040000_intake_mark_submitted_to_github_rpc.sql`; a plain PostgREST PATCH is blocked at the grant level by design, closing a P1 finding from the PR #8 security review). The service never uses this key for anything else and never derives it from an incoming request; every other database read/write in `services/llm-handler` rides the caller's own session JWT through PostgREST, scoped by the same `owner_rw` RLS the browser would get directly. Deliberately kept in its own path, not co-located with `/toolbelt/`'s `SUPABASE_DB_URL` (platform-migrations' own credential) -- two different powerful secrets serving two unrelated pipelines should never share one Infisical grant.

`SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are not secrets: the deploy job reads them from the same public repository variables Shell's build already uses (`vars.VITE_SUPABASE_URL`, `vars.VITE_SUPABASE_PUBLISHABLE_KEY`).

Extend the "VPS bootstrap" steps above with Handler A's own key pair: generate a second `ssh-keygen -t ed25519` pair, install its public half into the SAME `~deploy/.ssh/authorized_keys` (one OS user, multiple trusted keys is normal), store the private half at `/platform/llm-handler/LLM_HANDLER_SSH_KEY`, and `mkdir -p ~deploy/llm-handler`.

Manual rollback mirrors LifeOS's own container rollback: repoint the image tag and restart.

```bash
ssh deploy@<host> 'cd llm-handler && sed -i "s#^LLM_HANDLER_IMAGE=.*#LLM_HANDLER_IMAGE=ghcr.io/kgsmith19/hyperbolic-core/llm-handler:sha-<prior-sha>#" .env && docker compose up -d --wait'
test "$(curl -fsS https://<origin>/api/healthz)" = '{"status":"ok"}'
```

Record the workflow URL, deployed commit, health output, and rollback rehearsal, same as Shell. Live SSH, Infisical, tailnet ACL, and host behavior cannot be proven by repository tests.

## One-time platform migration adoption

`platform-migrations.yml` authenticates to Infisical the same way `deploy.yml` does, via a dedicated OIDC identity: set repository variables `INFISICAL_PROJECT_SLUG` (shared with the Shell deploy pipeline) and `INFISICAL_PLATFORM_MIGRATIONS_IDENTITY_ID` (its own identity, scoped to `/toolbelt/` only, per ADR-05's one-identity-per-pipeline rule -- never the same identity `shell-deploy` uses). Its `/toolbelt/` secret path must contain `SUPABASE_DB_URL`, a table-owner-privileged Postgres connection string for the platform project; this is the single most powerful credential in either pipeline, since it bypasses RLS entirely. Without these two variables set, every dispatch fails immediately at the Infisical step, before touching the database at all.

The platform project predates the Supabase CLI ledger. Run the explicit `baseline_legacy_ledger: true` dispatch from `main`. It accepts only an empty ledger or an exact ordered prefix of the 18 reviewed legacy versions plus the two S1 versions, and it requires an empty schema diff plus explicit legacy seed/grant/extension/job checks before repairing any missing metadata. It then resumes the additive `platform` owner bootstrap and `test` fence (S1) and stops. If a run is interrupted after ledger repair or during S1, rerun the same baseline mode; a divergent/non-prefix ledger remains a hard stop.

Next, follow `apps/toolbelt/docs/notes/2026-08-12-platform-idp-owner-setup.md`: create the owner, insert the single `platform.config` row, and configure the owner CI credential (S2/S3). A normal migration dispatch then refuses to continue unless exactly one owner is present, applies the remaining forward migrations once, and runs the live platform contract. Never use baseline mode to repair a divergent or post-S1 ledger; investigate any attached schema diff instead of repairing around it.
