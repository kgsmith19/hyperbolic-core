# Cloudflare agent access (#562)

How an authorized agent inspects and changes Hyperbolic Core's Cloudflare configuration without
the dashboard. The source of truth is `infra/cloudflare/` (OpenTofu, `cloudflare/cloudflare` 5.28.1,
pinned in `.terraform.lock.hcl`). `infra/cloudflare/cf.sh` is the only supported entry point.

## What is managed

| Resource | Name | Origin |
| --- | --- | --- |
| Access application | `Hyperbolic Core` → `core.kylegsmith.com`, 24 h | **imported** (owner-created), `prevent_destroy` |
| Access policy | `Owner Only` (allow, the owner's email only) | **imported**, `prevent_destroy` |
| Tunnel | `hyperbolic-core-prod` (remotely managed) | created, `prevent_destroy` |
| Tunnel ingress | `core.kylegsmith.com` → `http://127.0.0.1:8080`; `ssh-core.kylegsmith.com` → `ssh://127.0.0.1:22`; everything else 404 | created; **both hostnames require a valid Access JWT at cloudflared** |
| DNS | `core` and `ssh-core` CNAME → `<tunnel>.cfargotunnel.com`, proxied | created; no other record is touched |
| Access application | `Hyperbolic Core Ops` → `ssh-core.kylegsmith.com`, 1 h | created |
| Access policy + service token | `Hyperbolic Core Ops Service Token` / `hyperbolic-core-ops` | created |
| Access application | `LifeOS MCP` → `core.kylegsmith.com/life/mcp` (path-scoped), Owner Only, **Managed OAuth** (DCR limited to `mcp_oauth_redirect_uris`; 15 m tokens, 30 d grant) | created (#633); its AUD is also in the core tunnel ingress `aud_tag` |

`kylegsmith.com` and `www.kylegsmith.com` are reserved for the future public site. `cf.sh verify`
fails if either one ever points at the tunnel.

## Getting credentials

1. Authenticate to Infisical (project `hyperbolic-core`, environment `prod`) with a machine identity.
   - In a cloud agent session: `INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET` (universal auth),
     plus `INFISICAL_PROJECT_ID`.
   - In GitHub Actions: OIDC → `INFISICAL_TOKEN`.
2. `cf.sh` reads everything else itself: `/CLOUDFLARE_API_TOKEN`,
   `/platform/core/OWNER_EMAIL` and `/platform/cloudflare/TF_STATE_PASSPHRASE`. Nothing is printed.

Never paste a token into chat, an issue, a commit or a command line.

## Workflow

```bash
infra/cloudflare/cf.sh preflight   # token active; reads OK; Owner Only == exactly the owner email
infra/cloudflare/cf.sh plan        # preflight + plan; refuses any delete/replace
infra/cloudflare/cf.sh apply       # applies exactly the reviewed plan
infra/cloudflare/cf.sh publish-secrets  # tunnel token + ops service token -> Infisical
infra/cloudflare/cf.sh verify      # tunnel healthy, Access redirect, forged cookie refused, DNS scope
```

Guard rails, all enforced by `cf.sh`:

- Any plan containing a delete or replace is refused. `prevent_destroy` covers the Access app,
  the policy and the tunnel as well.
- Preflight stops when the Owner Only policy is anything other than the single owner email with no
  exclude or require rules. Broadening access needs a human decision, never an agent edit.
- One writer at a time: a local `flock`, and a refusal when `state/` differs from `origin/main`.
- Every change goes through a PR: the configuration and the encrypted state file are committed
  together, and the PR is the audit trail.

## State

- `infra/cloudflare/state/terraform.tfstate` is committed **encrypted** (OpenTofu state encryption,
  AES-GCM, PBKDF2 key from `TF_STATE_PASSPHRASE`). Plans are encrypted too.
- R2 is not enabled on the account. Enabling it, or any paid backend, needs owner approval.
- **Backups**: Git history keeps every committed state version.
- **Recovery**: every resource can be imported again. If the state or the passphrase is lost,
  delete `state/`, add `import {}` blocks for the tunnel, tunnel config, DNS records, ops app,
  policy and service token (IDs from the Cloudflare API, read-only), then `cf.sh plan`. The plan
  must show only imports and no changes. A service token's secret cannot be re-read: rotate it
  instead (below).

## Rotation

| Credential | How |
| --- | --- |
| Cloudflare API token | The owner creates a new `hyperbolic-core-deployer` token (same scopes, below), stores it in Infisical `/CLOUDFLARE_API_TOKEN`, runs `cf.sh preflight`, then deletes the old token. |
| Tunnel token | Rotate the tunnel secret (Cloudflare API `PATCH cfd_tunnel/{id}` with a new `tunnel_secret`), then `cf.sh publish-secrets`. On the host, over the still-open old connection, reinstall the service with the new token piped from Infisical, then `cf.sh verify`. |
| Ops service token | `cf.sh plan` refuses replaces, so this one is deliberate: with the same Infisical-loaded environment, run `tofu apply -replace=cloudflare_zero_trust_access_service_token.ops` and record it in a PR, then `cf.sh publish-secrets`. |
| Deploy SSH key | Generate a new pair, append the public half to `~deploy/.ssh/authorized_keys` over the old key, update both Infisical keys, then remove the old line. |

Required token scopes: Account › Cloudflare Tunnel: Edit; Account › Access: Apps and Policies:
Edit; Account › Access: Service Tokens: Edit; Account › Access: Organizations, Identity Providers,
and Groups: Read; Zone `kylegsmith.com` › DNS: Edit and Zone: Read.
