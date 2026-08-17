---
title: Third-Party Vendors
status: active
owner: Kyle
updated: 2026-08-17
---

# Third-Party Vendors

Every external service this platform depends on, in one place. Exact secret locations are
authoritative in [`docs/ops/runbook.md`](runbook.md) — this page names *which* path holds *what*
and links there rather than duplicating values that would drift.

## Cost

| Vendor | Plan | Cost / month |
| --- | --- | --- |
| Hetzner | VPS CPX11 (Ashburn) | ~€5.50 |
| Hetzner | Storage Box BX11 *(planned, #164)* | ~€3.81 |
| Tailscale | Personal (free) | €0 |
| Infisical | Free tier | €0 |
| Cloudflare | Tunnel + Access, ≤50 users *(mechanism built, #169; account planned, #170)* | €0 |
| Supabase | Free tier ×3 projects | €0 |
| GitHub | Actions minutes + ghcr, private repo | €0 (within free allowance) |
| age | n/a — a local encryption tool, not a hosted service | €0 |
| **Total (live today)** | | **~€5.50** |
| **Total (once Phases E/F land)** | | **~€9.31** (+ domain registration, ~€0.85/mo amortized) |

Target ceiling from the deployment plan: ≤~€10/mo. On track.

## Hetzner

**What:** the VPS running every deployed unit (Shell static bundle, Handler A, the Brain, and —
after the LifeOS cutover — the LifeOS backend + UI). Server: CPX11, Ashburn region.

**Auth:** SSH only — no Hetzner Cloud API automation exists in this repo (deliberately: the
pipeline is provider-agnostic and knows the box only as `vars.DEPLOY_HOST`, a tailnet DNS name).
Provisioning is the manual "VPS bootstrap" section of `runbook.md`.

**Secrets:** none stored for Hetzner itself — the box is reached via Tailscale, not a
Hetzner-issued credential.

**Rotation:** N/A (no long-lived Hetzner credential exists). If the VPS is ever rebuilt, re-run
`docs/ops/bootstrap-vps.sh` and re-approve the new tailnet node.

**Planned addition (#164):** a Storage Box (BX11) as the restic backup destination, reached over
SFTP (port 23) with its own sub-account per repository (`platform`, `lifeos`). Not yet provisioned.

## Tailscale

**What:** the private network fabric for everything. More than a VPN — it is the deploy transport
(Tailscale SSH: no SSH-key secrets for the LifeOS pipeline; the platform pipeline still uses
Infisical-stored SSH keys today, with keyless Tailscale SSH as the planned target — not yet a
scheduled Issue), the TLS terminator (`tailscale serve --https=443`
fronting the one-origin route table — see `runbook.md`'s "Single-origin Tailscale Serve routes"),
the authorization boundary (ACL: `tag:ci` → SSH to `tag:prod`, user `deploy`), and the CI identity
(`tailscale/github-action@780049a30b6ff5c378a9e7b389d15ece7a204888 # v4.1.3`, pinned, joins as an
ephemeral `tag:ci` node per run).

**Auth:** an OAuth client (`TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET`), scoped to mint `auth_keys`,
injected into every deploying/backing-up/operating workflow from Infisical — never a GitHub secret.

**Secrets:** the OAuth client pair is duplicated across every pipeline's own Infisical path
(`/platform/shell-deploy/`, `/platform/llm-handler/`, `/brain/`, `/platform/lifeos-deploy/`) — see
the [Infisical](#infisical) section below for why each pipeline carries its own copy rather than
sharing one.

**Rotation:** regenerate the OAuth client in the Tailscale admin console, update every Infisical
path that carries a copy (`runbook.md`'s path tables list every occurrence), and revoke the old
client. No workflow change needed — the client id/secret are read from Infisical, not hardcoded.

## Infisical

**What:** the sole secret store for every pipeline in this repo. No secret material lives as a
GitHub Actions secret except the built-in `GITHUB_TOKEN` (used only for ghcr login and the GitHub
API). Every workflow authenticates via OIDC — a short-lived GitHub Actions identity token exchanged
for the pipeline's own Infisical machine identity, scoped to exactly one secret path.

**Auth:** OIDC (`method: oidc` on every `Infisical/secrets-action@77ab1f4ccd183a543cb5b42435fbd181189f4995 # v1.0.16`
call) — no static Infisical API key exists anywhere in this repo.

**One-identity-per-pipeline (ADR-05):** each pipeline reads exactly one path, so a compromised
identity's blast radius is that pipeline's secrets alone. Live paths:

| Path | Reader(s) |
| --- | --- |
| `/platform/shell-deploy/` | Shell deploy, Ops Serve Apply, Platform Smoke |
| `/platform/llm-handler/` | Handler A deploy |
| `/brain/` | Brain deploy (deliberately never `/platform/…` — see `runbook.md`) |
| `/platform/` | Platform migrations (`SUPABASE_DB_URL`, table-owner privileged) |
| `/toolbelt/` | Platform backup |
| `/platform/lifeos-deploy/` | LifeOS deploy, LifeOS backup, LifeOS ops |
| `/review/` | LLM Review gate |
| `/platform/backup/` *(planned, #166)* | restic → Storage Box credentials |
| `/platform/edge/` *(pipeline built #169, awaiting owner's tunnel token)* | Cloudflare tunnel token |

**Rotation:** per-secret, in the Infisical console under the owning path; no workflow file changes
needed since every value is read at run time. Identity/OIDC trust rotation (rare) is documented per
pipeline in `runbook.md`.

## Cloudflare *(mechanism built — #165, #169; account/tunnel planned — #170)*

**What:** the public-internet edge. Owner decision: Cloudflare Tunnel (outbound-only, zero open
inbound ports on the VPS) + Cloudflare Access (SSO in front of whichever paths are explicitly
exposed). Additive to Tailscale — the private tailnet path is unaffected.

**Auth:** a tunnel token (Infisical `/platform/edge/`) authorizes `cloudflared` to establish the
outbound connection; Access policies are configured in the Cloudflare dashboard, not in code.

**Secrets:** tunnel token only, in Infisical.

**Rotation:** regenerate the tunnel token in the Cloudflare dashboard, update
`/platform/edge/`, redeploy the edge compose stack (`ops-edge.yml`, dispatch or push to
`docs/ops/edge-origin/**`).

**Status:** the local nginx origin (`docs/ops/edge-origin/`, #165), the `cloudflared` compose
service, and its dark-gated deploy pipeline (`ops-edge.yml`, `CLOUDFLARE_EDGE_ENABLED`, #169) are
built and tested — all buildable without a Cloudflare account at all. Not yet provisioned: the
account, domain, and Tunnel itself (owner action, `docs/ops/runbook.md`'s "Cloudflare edge origin"
section), and Access policies (#170).

## Supabase

**What:** hosted Postgres + PostgREST + Auth, across three projects:

| Project ref | Owner | Purpose |
| --- | --- | --- |
| `woltgcggxaehtuypkxqk` | Toolbelt / platform | `core`, `idea`, `prompt` schemas — the shared platform database |
| `vhbzblllaohuljtareza` | LifeOS (prod) | LifeOS's own schema |
| `yueddwuhxflzbjehqufw` | LifeOS (test) | CI-only |

**Auth:** the publishable (anon) key is public by design and hardcoded in six client-side
locations (documented as an operational hazard in root `AGENTS.md`); the service-role key and the
table-owner `SUPABASE_DB_URL` are privileged secrets, held only by the specific pipelines that need
them (Handler A's service-role key for one narrow RPC; the migrations pipeline's `SUPABASE_DB_URL`
via `/platform/`).

**Secrets:** `SUPABASE_SERVICE_ROLE_KEY` (Handler A), `SUPABASE_DB_URL` (platform migrations),
`DATABASE_URL` (LifeOS pipelines) — each scoped to its own Infisical path.

**Rotation:** regenerate in the Supabase dashboard per project; update every Infisical path holding
a copy (cross-referenced in `runbook.md`); RLS policies are unaffected by key rotation.

## GitHub

**What:** source of truth for code, Issues, and PRs; CI/CD via Actions; container registry via
ghcr.io for the Brain and Handler A images (LifeOS images are shipped by `docker save | ssh` with
**no registry at all**, deliberately — see `lifeos-deploy.yml`'s header comment on the Workflow
Safety Invariant).

**Auth:** the built-in, automatically-rotated `GITHUB_TOKEN` — the only `secrets.*` reference
anywhere in this repo's workflows besides the LLM Review gate's provider keys.

**Secrets:** none long-lived. `GITHUB_TOKEN` is minted per-run and expires with the job.

**Rotation:** N/A — GitHub rotates this automatically every run.

## age

**What:** the asymmetric encryption tool wrapping every backup bundle before it leaves CI (`age -r
<public-key>`). Not a hosted service — a local binary, installed fresh in each backup job
(`apt-get install age`).

**Auth:** public-key encryption. CI holds only the **public** recipient key; the private decryption
key is never uploaded anywhere and lives offline with the owner.

**Secrets:** the public recipient key is a plain repository variable (not secret) — deliberately
distinct per pipeline so a compromise of one never exposes the other's archive:

| Variable | Pipeline |
| --- | --- |
| `PLATFORM_AGE_PUBLIC_KEY` | Platform backup (cron `52 9 * * *`) |
| `LIFEOS_AGE_PUBLIC_KEY` | LifeOS backup (cron `41 8 * * *`) |

**Rotation:** generate a new `age-keygen` keypair, update the repository variable with the new
public half, keep the old private key offline until every artifact encrypted under it has expired
(90-day retention) or been re-encrypted during a restore drill.

---

## Rotation summary

| Credential | Where it lives | Rotation trigger |
| --- | --- | --- |
| Tailscale OAuth client (×4 copies) | Infisical, per-pipeline paths | Tailscale admin console; update all copies |
| Infisical OIDC trust | Infisical console, per identity | Rare — repo/org rename only |
| Supabase service-role key | `/platform/llm-handler/` | Supabase dashboard; update the one path |
| Supabase `SUPABASE_DB_URL` (table-owner) | `/platform/` | Supabase dashboard; update the one path |
| LifeOS `DATABASE_URL` | `/platform/lifeos-deploy/` | Supabase dashboard; update the one path |
| Brain Anthropic API key | `/brain/` | Anthropic console; update the one path |
| LLM Review provider keys | `/review/` | Provider console; update the one path |
| age recipient keypairs (×2) | repo vars (public) + owner-held (private) | `age-keygen`; retire old private key after retention window |
| SSH deploy keys (×3, platform pipeline only) | Infisical, per-pipeline paths | `bootstrap-vps.sh`; planned unification onto keyless Tailscale SSH (not yet scheduled) |
| restic repository password + SFTP key *(pipeline built #164/#166/#167, awaiting Storage Box)* | `/platform/backup/` | Storage Box console + `restic key` |
| Cloudflare tunnel token *(pipeline built #169, awaiting owner's Tunnel)* | `/platform/edge/` | Cloudflare dashboard |
