# ADR 009: Service/repo boundaries and Infisical secrets management

## Decision

**Boundary rules.** A capability becomes a new *deployable* (compose service)
only when it needs an independent lifecycle or failure isolation — same repo
by default (the embedding worker will be a second process of this repo, not a
new repo). A capability becomes a new *repo* only when a second real consumer
exists with a different change cadence or trust surface — extract on the
second consumer, never on prediction. Commodity security infrastructure —
secrets managers, identity providers, gateways, notification brokers — is
**installed or bought, never authored**; we write domain logic and thin glue.
Many "future apps" should first be considered as lifeos *domains* (type
definitions + data, per ADR 002), which need no new repo at all.

**Secrets.** A custom keys service is rejected: every client still needs a
credential to reach it (secret zero survives), on a single VPS it protects
nothing a `.env` doesn't (a compromised box reads either), and it would make
the highest-value target the least-audited component we own — invariant 8's
logic applied to ourselves. Instead, **Infisical Cloud** is the one protected
spot for dev/API/third-party keys (free tier: 5 identities, 3 projects, 3
environments). CI authenticates with **OIDC machine identities** — GitHub
stores **zero long-lived secrets**; workflows exchange short-lived OIDC
tokens for scoped read access at run time, and the VPS `.env` is rendered
from Infisical on every deploy, so rotation is edit-and-redeploy.

**Auth.** The identity provider stays Supabase Auth (ADR 008). The reusable
part is `src/api/auth.py` — ~150 lines of stateless verification — which is a
*library*, not a service: it becomes a private pip package when a second
consuming app exists. A deployed auth microservice would add a network hop
and an availability dependency to every request while doing the same local
crypto.

**LLM keys.** When the first LLM call ships, provider keys go into a
**LiteLLM gateway** (installed product, one compose service): apps get
per-app virtual keys with budgets and usage tracking; provider keys live only
in the gateway. Until then, nothing.

## Consequences

- No new repos today. Planned extractions and their triggers:
  auth package — second consuming app; `platform` repo (compose stacks,
  provisioning, runbook, reusable `workflow_call` CI) — second deployable;
  LiteLLM — first LLM usage; notifications (ntfy/Apprise) — first real
  notification need; self-hosted IdP (Pocket ID/Zitadel) — only if Supabase
  Auth chafes; 1Password/family passwords — separate personal decision.
- GitHub Actions holds variables only (all non-secret); the Infisical
  identity is bound to this repo's OIDC claims, so a leaked variable grants
  nothing.
- Watch-item: Infisical Pro is $18/identity/month — stay within the 5-identity
  free tier (currently: owner + one CI identity); self-hosted Infisical or
  OpenBao on the tailnet is the escape hatch if pricing or trust shifts.

## Revisit when

A second consuming app or deployable appears (triggers above fire), identity
count approaches 5, or any component asks to hold another component's
credentials (that is the custom-keys-service smell again — say no).
