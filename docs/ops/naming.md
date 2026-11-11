# Naming (#562)

Hyperbolic Core (`hyperbolic-core`) is the parent platform. Its sub-applications keep their own
names (`lifeos`, `brain`, `platform-api`, `broker`, `network-checker`, `shell`). Renames are made
only where they are non-destructive. Where a rename would recreate infrastructure or break an
integration, the resource is aliased or deferred instead.

| Surface | Current name | Target | Action |
| --- | --- | --- | --- |
| GitHub monorepo | `kgsmith19/hyperbolic-core` | same | none |
| Compose project | `hyperbolic-core` (`compose.yaml` `name:`) | same | none |
| Compose services | `platform-api`, `lifeos`, `brain`, `broker`, `network-checker`, `edge` | same | added label `hyperbolic-core.app=<name>` (cloud overlay) |
| Primary server | none (new) | `hyperbolic-core-prod` | **created** with labels `platform=hyperbolic-core, env=prod` |
| Firewall | none (new) | `hyperbolic-core-prod-fw` | **created** |
| Hetzner SSH key | none (new) | `hyperbolic-core-prod-deploy` | **created** |
| Old server | `lifeos-prod` | (retire) | **deferred**: unchanged until its data is checked and the owner approves a decommission |
| Storage Box | `hyperbolic-backups` | same | none (already platform-named) |
| Infisical project | `hyperbolic-core` (slug `hyperbolic-core-aeme2`) | same | none |
| Infisical paths | existing `/platform/*`, `/brain`, `/providers/*` | same | new keys under `/platform/core`, `/platform/core-tunnel`, `/platform/cloudflare`; **no existing path renamed** (identities and workflows depend on them) |
| Cloudflare tunnel | none (new) | `hyperbolic-core-prod` | **created** |
| Access app | `Hyperbolic Core` | same | imported, unchanged |
| Access policy | `Owner Only` | same | imported, unchanged |
| Ops Access app / token | none (new) | `Hyperbolic Core Ops` / `hyperbolic-core-ops` | **created** |
| URL | `core.kylegsmith.com` | same | routed through the tunnel |
| Host paths | none (new) | `/srv/hyperbolic-core/{releases,var,env,backups}` | **created** |
| systemd units | none (new) | `hyperbolic-core.service`, `hyperbolic-core-{backup,monitor}.{service,timer}` | **created** |
| Docs | "local-only platform" wording (AGENTS.md, vendors, hosting decision) | parent platform + cloud host | updated; historical #503/#504 records kept as written |

| GitHub deploy workflow / environment | none (new) | `Core Deploy` (`core-deploy.yml`) / `ops-edge-production` | **created**; the environment keeps a legacy name |

## Deferred, with reasons

- **GitHub environment `ops-edge-production`**: the existing Infisical identity `shell-deploy`
  trusts that environment name through GitHub OIDC. Reusing it adds no new access. A rename to
  `hyperbolic-core-production` needs an owner-approved change to the identity's trusted subject.

- **`lifeos-prod`**: may hold the only copy of old LifeOS data, so it is not touched before migration
  and owner approval.
- **Infisical secret paths** such as `/platform/lifeos-deploy`: renaming them would break the
  OIDC identities scoped to those paths, for no functional gain.
- **GitHub repository names**: unchanged. Cosmetic renames carry redirect and integration risk.
