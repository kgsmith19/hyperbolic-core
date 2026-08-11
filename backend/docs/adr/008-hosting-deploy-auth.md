# ADR 008: Tailnet-only VPS hosting, GitHub Actions deploys, Supabase Auth JWTs

## Decision
The API (and every future service) runs in Docker Compose on one small VPS
that is reachable only over the owner's private Tailscale network — no public
ports; `tailscale serve` provides HTTPS on the tailnet. Deploys are GitHub
Actions on merge to main: lint/type/test against an ephemeral Postgres,
image to GHCR, `supabase db push` for migrations, then compose pull/up over
Tailscale SSH (CI joins as an ephemeral tagged node; no SSH key secrets).

Auth is two independent layers. Network: only Tailscale-approved devices can
reach anything. Application: every request needs a Supabase Auth JWT, verified
locally against the project JWKS (ES256 only), with `iss`/`aud`/`exp` checks,
the subject allowlisted to the single owner user, and an optional `scopes`
claim narrowing the AccessContext — the agent seam of ADR 005/006. Signups
are disabled; Supabase Auth is already inside the trust boundary (ADR 003).
`LIFEOS_AUTH_MODE=disabled` exists for local dev and route tests only; the
default fails closed. Kernel tables additionally have RLS enabled with no
policies, so the Supabase Data API roles (anon/authenticated) can never touch
them; only the direct lifeos_app connection (table owner) works.

Data durability on the free tier is our own: a nightly GitHub Actions
`pg_dump`, age-encrypted to a public key (private key offline), kept 30 days
as artifacts — which also generates the activity that prevents free-tier
pausing. Move to Supabase Pro when losing a week of data would actually hurt.

## Consequences
- ~$6/mo total (VPS); Tailscale, GitHub, and Supabase free tiers cover the
  rest. Additional services are compose entries at no cost until the box fills.
- Being unreachable is the primary control; a compromised token or app bug
  still meets the network wall, and vice versa.
- Static API keys never exist; every credential is an expiring JWT with an
  identity, so future agent tokens reuse the same verification path with
  narrower scopes.
- Free-tier Supabase has no managed backups and pauses when idle; the backup
  workflow is load-bearing and must stay green.

## Revisit when
A second principal (human or agent) needs access, any endpoint must become
publicly reachable (webhooks, remote MCP — expose that route via Cloudflare
Tunnel + Access, never the box), daily capture makes Supabase Pro's managed
backups worth $25/mo, or Supabase passkeys reach GA (adopt as sign-in).
