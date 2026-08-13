---
title: Platform Operations Runbook
status: active
owner: Kyle
updated: 2026-08-13
---

# Platform Operations Runbook

## Single-origin Tailscale Serve routes

The VPS exposes one tailnet-only HTTPS origin. Tailscale provides the network boundary; applications still enforce authentication and authorization.

| Path | Target | State |
| --- | --- | --- |
| `/` | `/home/deploy/shell/current` | active static bundle |
| `/life/` | `/home/deploy/lifeos-ui/dist` | active static bundle |
| `/life/api/` | `http://127.0.0.1:8000` | active loopback proxy |
| `/brain/stream` | `http://127.0.0.1:8100` | reserved; do not configure before the Brain exists |

The command shape follows the current [Tailscale Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve). Run the checked-in operator script on the VPS:

Do not apply these routes until the LifeOS m2-08 base-path release is deployed. The script proves the built LifeOS asset URLs use `/life/` and that the loopback `/healthz` endpoint responds before it changes any route.

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

The deploy job uploads into a run-specific staging directory, atomically switches `shell/current`, and verifies both `/healthz` and the built JavaScript asset through the real tailnet origin. A failed activation or health proof restores the previous symlink automatically. Only after health succeeds does `prune-dist-dirs.sh` retain the newest three releases.

A manual `Platform Deploy` dispatch defaults to deploying Shell without touching the database. Set `apply_migrations: true` only when the pending migration set has been reviewed and the owner/ledger preflights are expected to pass; this remains main-only and runs before Shell activation. `deploy_shell` can be disabled for an explicit migration-only dispatch.

Manual rollback remains available without a rebuild:

```bash
ssh deploy@<host> 'ln -s dist-<prior-sha> shell/current.rollback && mv -Tf shell/current.rollback shell/current'
test "$(curl -fsS https://<origin>/healthz)" = '{"status":"ok"}'
```

Record the workflow URL, deployed commit, health output, and rollback rehearsal. Live SSH, Infisical, tailnet ACL, and host behavior cannot be proven by repository tests.

## One-time platform migration adoption

The platform project predates the Supabase CLI ledger. Run the explicit `baseline_legacy_ledger: true` dispatch from `main`. It accepts only an empty ledger or an exact ordered prefix of the 18 reviewed legacy versions plus the two S1 versions, and it requires an empty schema diff plus explicit legacy seed/grant/extension/job checks before repairing any missing metadata. It then resumes the additive `platform` owner bootstrap and `test` fence (S1) and stops. If a run is interrupted after ledger repair or during S1, rerun the same baseline mode; a divergent/non-prefix ledger remains a hard stop.

Next, follow `apps/toolbelt/docs/notes/2026-08-12-platform-idp-owner-setup.md`: create the owner, insert the single `platform.config` row, and configure the owner CI credential (S2/S3). A normal migration dispatch then refuses to continue unless exactly one owner is present, applies the remaining forward migrations once, and runs the live platform contract. Never use baseline mode to repair a divergent or post-S1 ledger; investigate any attached schema diff instead of repairing around it.
