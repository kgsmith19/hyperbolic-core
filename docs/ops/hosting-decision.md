# Hosting and access decision record (#559 AC7)

Status: **superseded on 2026-11-11** by the owner's cloud decision on #562: Hetzner CX33
`hyperbolic-core-prod` (EU, ≈US$12/month with provider backups) behind Cloudflare Tunnel + Access,
without the home-machine step. The live design is `docs/ops/cloud-deploy.md`. The 2026-11-07
comparison below is kept as the record of what was weighed.

## Options compared

| Option | Purpose | Access control | Why / why not |
| --- | --- | --- | --- |
| Home-machine preview: Cloudflare Tunnel + Cloudflare Access | Temporary remote access to the local stack | Access policy, owner email only; the origin is never public | Outbound-only connector, no open router ports, no Tailscale. Needs the local machine on. |
| Small managed VM (for example a 4 GB / 2 vCPU Droplet) + the same Tunnel and Access | Always-on private preview | Same Access policy; the origin stays on loopback | Same Access model, so the user URL does not change when the connector moves. Needs a backup and restore drill. |
| Tailscale | Private-network alternative | Tailnet membership | Works well for operator SSH. Not needed for browser use if Access covers it. Deferred. |

## Recommendation

1. Use the home-machine preview first (#562 phases 0 to 4). It needs no spend and proves the Access boundary.
2. Move the connector to a VM only after the local privacy tests pass (#562 phase 6).
3. Keep Tailscale deferred unless operator SSH needs a private network.

## Required before any purchase or provisioning

- Owner choice of domain and identity method (Google login or email one-time passcode).
- Verified monthly cost for the VM, the domain, and any Cloudflare plan the Access policy needs.
- Backup target and a tested restore (`make restore-drill`) before relying on the VM.
- Confirmation of which browser UI is exposed first (Shell or LifeOS).

## Not in scope

No provisioning, no secret migration, no public exposure, no agent production-admin credentials.
