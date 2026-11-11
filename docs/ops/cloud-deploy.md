# Cloud deployment: hyperbolic-core-prod (#562)

Owner decision 2026-11-11: Hyperbolic Core runs persistently in the cloud, independent of the
owner's computers, at **https://core.kylegsmith.com**.

```
Browser ─► Cloudflare Access ("Hyperbolic Core", policy "Owner Only", 24 h session)
        ─► Cloudflare Tunnel "hyperbolic-core-prod" (outbound-only, cloudflared checks the Access JWT)
        ─► 127.0.0.1:8080 edge (Caddy: production Shell + LifeOS UI + same-origin API proxy)
        ─► platform-api · lifeos · brain        (compose network only; no host ports)
           broker · network-checker             (internal; not routed at all)
```

Live since 2026-11-11 (Hetzner server id 175630450, `nbg1`; tunnel id
`8b2840d2-3214-454a-8077-3f35b938a0ad`). Verification evidence is on #562.

## What runs where

| Piece | Where | Notes |
| --- | --- | --- |
| Host | Hetzner Cloud **CX33** `hyperbolic-core-prod`, Ubuntu 24.04, `nbg1` | 4 vCPU / 8 GB / 80 GB; provider backups on; delete + rebuild protection |
| Firewall | `hyperbolic-core-prod-fw` | **No inbound rules.** sshd listens on 127.0.0.1 only |
| Edge | compose service `edge` (`apps/shell/Dockerfile`, `ops/cloud/Caddyfile`) | `/` Shell, `/life/` LifeOS UI, `/platform/*` platform-api, `/life/api/*` LifeOS, `/api/brain/*` Brain (SSE) |
| Stack | `compose.yaml` + `compose.cloud.yaml`, project `hyperbolic-core` | Same images as local; the overlay drops every host port but edge's loopback 8080 |
| Tunnel connector | `cloudflared` systemd service on the host | Separate from compose, so the operator channel survives a broken app release |
| Operator SSH | `ssh-core.kylegsmith.com` through the tunnel | Access app "Hyperbolic Core Ops": service token `hyperbolic-core-ops` or the owner |
| State | `/srv/hyperbolic-core/var` (bind mounts) | SQLite (WAL) + LifeOS blobs; survives restarts, redeploys and reboots |
| Runtime env | `/srv/hyperbolic-core/env` (0700) | platform identity, LifeOS/Brain env, Brain key file, restic credentials |

**Sign-in** (details in `docs/ops/login.md`): Cloudflare Access, with a one-time PIN to the owner
email, then single sign-on into the platform. platform-api verifies the `Cf-Access-Jwt-Assertion`
(RS256, the team's certs, issuer, the core app's AUD, expiry) and issues an owner session when the
email is the platform owner's (`grant_type=cloudflare_access`, `services/platform-api/src/cf-access.ts`).
The platform password (Infisical `prod:/platform/core/PLATFORM_OWNER_PASSWORD`) is the break-glass
fallback. Platform JWTs are ES256; their issuer stays the internal
`http://platform.localhost:8400/auth/v1`, which LifeOS and Brain verify inside the compose network.
The browser reaches the platform same-origin at `/platform`, so no CORS is needed.

## Credentials (Infisical project `hyperbolic-core`, env `prod`)

| Path / key | Used by | Written by |
| --- | --- | --- |
| `/CLOUDFLARE_API_TOKEN` | `infra/cloudflare/cf.sh` | owner (scoped token `hyperbolic-core-deployer`) |
| `/platform/cloudflare/TF_STATE_PASSPHRASE` | OpenTofu state encryption | first setup |
| `/platform/core-tunnel/TUNNEL_TOKEN` | cloudflared on the host (cloud-init) | `cf.sh publish-secrets` |
| `/platform/core/OPS_ACCESS_CLIENT_ID`, `OPS_ACCESS_CLIENT_SECRET` | operator SSH through Access | `cf.sh publish-secrets` |
| `/platform/core/DEPLOY_SSH_PRIVATE_KEY`, `DEPLOY_SSH_PUBLIC_KEY` | operator SSH as `deploy` | `provision.sh` (once) |
| `/platform/core/OWNER_EMAIL` | Access policy check, platform owner | first setup (from the Owner Only policy) |
| `/platform/core/PLATFORM_OWNER_PASSWORD` | the owner's app sign-in; `remote.sh smoke` | `remote.sh deploy` (first run) |
| `/providers/hetzner/HETZNER_API_TOKEN` | `provision.sh` | existing |
| `/brain/BRAIN_ANTHROPIC_API_KEY` | Brain only (ADR-05 file mount + ACC vault) | existing |
| `/platform/lifeos-deploy/ANTHROPIC_API_KEY`, `LIFEOS_BRIEFING_TZ` | LifeOS | existing |
| `/platform/backup/RESTIC_PASSWORD`, `STORAGEBOX_SSH_KEY` | nightly restic | existing |

Nothing secret is committed, printed, or passed on a command line: scripts move values on stdin.

## Automatic deploys (GitHub Actions)

`.github/workflows/core-deploy.yml` (**Core Deploy**) deploys every push to `main` that touches
the deployed stack. Merges reach `main` only through the PR Gate. It runs the same
`ops/cloud/remote.sh deploy <sha>` as an operator would, so the host-side backup, the smoke check
and the automatic restore of the last good release all apply. Run it by hand (Actions → Core
Deploy → Run workflow) to redeploy a ref or to roll back.

- **Credentials:** GitHub OIDC → the existing Infisical identity `shell-deploy`, which trusts this
  repo's `ops-edge-production` environment. There are no repository secrets.
- **Optional owner gate:** add required reviewers to the `ops-edge-production` environment
  (Settings → Environments). Deploys then wait for approval.
- **Concurrency:** one deploy at a time (`core-deploy-production`), never cancelled mid-flight.

## Operating it

All commands run from a repository checkout with an Infisical machine identity
(`INFISICAL_PROJECT_ID` plus `INFISICAL_TOKEN` or `INFISICAL_CLIENT_ID`/`INFISICAL_CLIENT_SECRET`),
`cloudflared`, `ssh`, and `tofu` (OpenTofu 1.10+) on PATH.

| Task | Command |
| --- | --- |
| Deploy a commit (default `HEAD`) | `ops/cloud/remote.sh deploy <ref>` |
| Roll back to the previous release | `ops/cloud/remote.sh rollback` (again to undo) |
| Owner journey smoke test | `ops/cloud/remote.sh smoke` |
| Shell on the host | `ops/cloud/remote.sh ssh` (or `ssh … <command>`) |
| Backup now | `ops/cloud/remote.sh backup` |
| Cloudflare inspect / change | `infra/cloudflare/cf.sh preflight|plan|apply|verify` |
| Create the host (once) | `ops/cloud/provision.sh` |

`deploy` ships `git archive <sha>` over SSH, refreshes the env files from Infisical, then runs
`ops/cloud/host/deploy.sh` on the host: pre-deploy SQLite backup → broker policy → `docker compose
build` → `up --wait` → `ops/cloud/host/smoke.sh`. If any step fails, the last good release is
started again automatically, and `releases.log` records both. The five newest releases are kept
under `/srv/hyperbolic-core/releases/`; `current` and `previous` are symlinks.

## Reliability

- **Restart/reboot**: every service has `restart: unless-stopped` and a health check;
  `hyperbolic-core.service` starts the live release at boot; `cloudflared` is its own systemd
  service. Unattended security upgrades may reboot at 04:30 UTC.
- **Monitoring**: `hyperbolic-core-monitor.timer` (5 min) checks service health
  (`ops/telemetry.py`), the edge, cloudflared, disk (< 85 %) and memory. Read it with
  `journalctl -t hyperbolic-core -p warning`. Cloudflare reports tunnel health in `cf.sh verify`.
- **Backups**:
  1. Hetzner provider backups (daily image, 7 kept).
  2. `hyperbolic-core-backup.timer` at 03:17 UTC runs `ops/store_ops.py backup` (online SQLite
     backup + blobs, checksummed) and a **restore drill** of that snapshot. It keeps 7 locally,
     then sends the snapshot plus `env/` to the Storage Box `hyperbolic-backups` with restic
     (encrypted; keeps 7 daily, 4 weekly and 6 monthly).
  3. A pre-deploy snapshot before every release (3 kept).
- **Restore**: `restic -r sftp:storagebox:hyperbolic-core restore latest --target /tmp/r` (env from
  `/srv/hyperbolic-core/env/restic.env`). Then stop the stack, copy the `*.db` files and `blobs/`
  into `/srv/hyperbolic-core/var/<app>/`, and run `sudo systemctl start hyperbolic-core`.
  `ops/store_ops.py restore-drill <dir>` proves a snapshot first.

## Cost (2026-11)

| Item | Monthly |
| --- | --- |
| Hetzner CX33 (nbg1) | US$9.99 |
| Hetzner provider backups (+20 %) | US$2.00 |
| Storage Box BX11 `hyperbolic-backups` | already paid (shared) |
| Cloudflare DNS, Tunnel, Access (Zero Trust free, ≤ 50 users) | US$0 |
| **New spend** | **≈ US$12** |

Model usage (Anthropic) is billed separately per use. `lifeos-prod` (CPX11, Ashburn, ≈ US$20.49)
is still running and billed; it is kept until its data is checked (see #562).

## Owner responsibilities

- Keep the Cloudflare account, the `kylegsmith.com` registration and the Hetzner account in good standing.
- Approve any change to the Access policy, any new paid resource, and any destructive action.
- Rotate tokens yearly (`docs/ops/cloudflare-agent-access.md#rotation`); the ops service token expires after 8760 h.
- Sign-in is one step: the Access one-time PIN to the owner email, then single sign-on (`docs/ops/login.md`).

## Known limitations

- **ACC** (Agentic Command Center) is a process on the operator's own machine; its Shell tile shows
  "Unreachable" in the cloud by design.
- **Idea Intake submit** depends on llm-handler, which needs the retired Supabase stack; it is not deployed.
- **Brain** runs with its provider key and authenticated API. Coding runs that push to GitHub also
  need a repository credential, which is not provisioned (follow-up).
- **network-checker** and **broker** run but are not routed to the browser (internal only).
