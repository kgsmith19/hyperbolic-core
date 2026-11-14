# ADR: Agent ingress. One MCP surface, swappable sign-in, edge and tunnel adapters

Status: accepted (owner decision, 2026-11-14). Builds on ADR 010 (agent tokens) and #596
(controller requests).

## Context

LifeOS had one agent door per harness. Claude Code used a stdio MCP subprocess, and ChatGPT
was meant to use a "connector" that was never built. The public API sits behind Cloudflare
Access, so no third-party harness could reach it, and a pasted long-lived token per harness
does not scale or rotate.

ChatGPT, Claude, Codex, Cursor and others now connect to tools the same way: a **remote MCP
server acting as an OAuth 2.1 resource server**. It publishes RFC 9728 protected-resource
metadata, answers an unauthenticated call with `401` plus a `resource_metadata` pointer, and
leaves token issuance to a separate authorization server. Client registration happens between
the client and the authorization server (CIMD, with DCR as a fallback).

## Decision

LifeOS exposes **one** remote MCP surface (`python -m mcp_server --http`,
`mcp_server/http.py`) and keeps everything provider-specific behind three ports:

| Port | Responsibility | First adapter | Swap by |
| --- | --- | --- | --- |
| `TokenVerifier` (MCP SDK protocol) | Verify a bearer token and return the caller | `AgentTokenVerifier`: LifeOS ES256 agent tokens (`aud=lifeos-mcp`) | Adding a verifier, for example generic JWKS for Keycloak or WorkOS |
| `EdgeIdentity` (`mcp_server/ingress.py`) | Verify an identity the edge proxy asserted after it ran the OAuth sign-in | `CloudflareAccessEdge`: `Cf-Access-Jwt-Assertion`, team JWKS and app AUD | `LIFEOS_MCP_EDGE` plus an adapter (Pomerium, ngrok, ...) |
| Authorization server | Sign-in, consent and client registration | Cloudflare Access Managed OAuth (`LIFEOS_MCP_AUTH_ISSUER`) | Configuration only: the server never issues tokens |
| Tunnel | Publish only `/mcp` and its well-known metadata | Cloudflare Tunnel (existing) | The deploy's proxy config. hyper-agents owns the `TunnelPort` op. |

Tools are the four read-only tools of the stdio server, plus `request_decision`, which is
exactly POST /agents/requests. `requested_by` is the verified caller, the role must be in the
caller's allowlist, `approved` cannot be sent, and nothing executes. An edge identity gets only
the scopes and roles configured for it, and those go through the same validation as a minted
token.

## Consequences

- A harness connects once by OAuth. The owner approves a consent screen, and no token is pasted
  anywhere. MB-004 (consent) becomes "connect each harness once". It ticks itself on that
  harness's first `request_decision` receipt.
- Cloudflare Access Managed OAuth identifies the owner, not the harness. Until per-client
  identity reaches the origin, every edge-signed-in harness shares one configured role set
  (default: the ChatGPT controller roles). Agent tokens keep per-controller allowlists.
- The server is stateless (one credential per request), returns JSON responses, and guards
  against DNS rebinding with an allowlist of the published host.
- Deployed (#633): the `LifeOS MCP` Access app (`infra/cloudflare`, Managed OAuth) fronts
  `/life/mcp`, and Caddy routes it to the `lifeos-mcp` service. Discovery is served by Access
  itself: a `401` points at `/.well-known/cloudflare-access-protected-resource/life/mcp`, which
  names the team authorization server (RFC 8414, dynamic client registration, PKCE S256).
  The origin's own RFC 9728 metadata stays for direct (agent-token) use.

## Bill-payment preparation is not an MCP payment tool (#637)

The backend's `domains.bills.launcher.prepare_payment_handoff(row, provider,
as_of)` composes the existing two-minute launcher with reviewed public provider
pages. Supported provider keys are `hagerstown`, `firstenergy`, and `antietam`.
The result contains a transient human-review plan and a portal source/review date,
not a payment command or permission. Routes expire 90 days after their recorded
review; unknown providers and expired routes return no destination. Amounts and
account identifiers are not copied into the handoff.

Provider selection is caller-supplied, not matched to the bill/payee identity;
`payee_match` is always `not_verified`. A reviewed public destination is not proof
that it is the correct payee for this bill.

Authentication is always `not_checked`: this helper does not inspect a provider
session. `executed` is always false. A link does not establish an account
connection, verify fees, authorize a transaction, or prove payment. Unknown,
nonpositive/nonfinite amounts, stale balance evidence, duplicate/excluded/paid
rows, and rows without an actionable launcher plan return a blocked result.
Confirm current bill status, amount and fees in the provider-owned portal.

This is a pure, non-networked backend preparation slice, not a deployed UI or
public MCP endpoint. The existing sensitive-domain exclusions and PAYMENT denial
remain unchanged. Any owner-facing API/UI wiring needs its own service-boundary
review; do not expose sensitive bills through generic MCP reads to use this helper.
