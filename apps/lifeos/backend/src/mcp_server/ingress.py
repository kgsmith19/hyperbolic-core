"""Who is calling the remote MCP door: provider-neutral ports, one adapter per provider.

A request reaches the remote transport (mcp_server.http) with exactly one of:

- a LifeOS agent token as a bearer token (self-issued ES256, ADR 010, #596). Any harness
  that can send a header can use it; `AgentTokenVerifier` checks it.
- an identity asserted by the edge proxy in front of the server, after that proxy has run
  the OAuth sign-in itself (for example Cloudflare Access Managed OAuth: the client holds an
  opaque token, and the origin receives a signed assertion header). `EdgeIdentity` is the
  port and `CloudflareAccessEdge` the first adapter. Swapping proxies (Pomerium, ngrok,
  Keycloak-fronted gateways) means adding an adapter, not changing the tools.

Rules held here:

- Fail closed. No verified identity means no principal, and the bearer middleware answers 401
  with the RFC 9728 resource-metadata pointer.
- An edge identity never gains more than its configured scopes and roles, and those pass
  through the same `read_scopes` / role-allowlist validation as a minted token.
- The edge assertion is checked on every request (signature, audience, expiry); a header is
  never trusted for being present.
"""

from __future__ import annotations

import contextvars
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

import jwt
from mcp.server.auth.provider import AccessToken

from mcp_server.tokens import AgentTokenError, read_scopes, request_roles, verify_claims


@dataclass(frozen=True)
class EdgePrincipal:
    subject: str
    scopes: tuple[str, ...]
    roles: tuple[str, ...] | None
    via: str
    claims: dict[str, Any] = field(default_factory=dict)


class EdgeIdentity(Protocol):
    """Port: verify the identity an edge proxy asserted for this request, or return None."""

    name: str

    def verify(self, headers: Mapping[str, str]) -> EdgePrincipal | None: ...


_EDGE: contextvars.ContextVar[EdgePrincipal | None] = contextvars.ContextVar(
    "lifeos_mcp_edge_principal", default=None
)


class CloudflareAccessEdge:
    """Adapter: Cloudflare Access forwards `Cf-Access-Jwt-Assertion` (RS256, signed by the
    team's certs) after its own sign-in. Verified here against the team JWKS and the app AUD.
    """

    name = "cloudflare-access"
    HEADER = "cf-access-jwt-assertion"

    def __init__(
        self,
        team_domain: str,
        audience: str,
        scopes: Iterable[str],
        roles: Iterable[str] | None,
        jwks: Callable[[str], Any] | None = None,
    ) -> None:
        if not team_domain or not audience:
            raise ValueError("cloudflare-access edge needs a team domain and an application AUD")
        self._issuer = f"https://{team_domain}"
        self._audience = audience
        self._scopes = tuple(sorted(read_scopes(scopes)))
        self._roles = tuple(roles) if roles else None
        request_roles(frozenset(self._scopes), list(self._roles) if self._roles else None)
        client = jwt.PyJWKClient(f"{self._issuer}/cdn-cgi/access/certs")
        self._signing_key = jwks or (lambda token: client.get_signing_key_from_jwt(token).key)

    def verify(self, headers: Mapping[str, str]) -> EdgePrincipal | None:
        token = headers.get(self.HEADER)
        if not token:
            return None
        try:
            claims = jwt.decode(
                token,
                self._signing_key(token),
                algorithms=["RS256"],
                audience=self._audience,
                issuer=self._issuer,
                options={"require": ["exp", "iat", "aud", "iss", "sub"]},
            )
        except (jwt.PyJWTError, ValueError):
            return None
        who = claims.get("email") or claims["sub"]
        return EdgePrincipal(
            subject=f"access:{who}",
            scopes=self._scopes,
            roles=self._roles,
            via=self.name,
            claims={"iss": claims.get("iss"), "sub": claims.get("sub")},
        )


class EdgeIdentityMiddleware:
    """ASGI middleware: verify the edge assertion once per request and expose it to the
    bearer verifier for the duration of that request only."""

    def __init__(self, app: Any, edge: EdgeIdentity) -> None:
        self.app = app
        self.edge = edge

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        principal = self.edge.verify(headers)
        if principal is not None and "authorization" not in headers:
            # The edge may strip the client's opaque token; the bearer check must still run,
            # and it resolves to the verified edge principal, never to this placeholder.
            scope = {**scope, "headers": [*scope["headers"], (b"authorization", b"Bearer edge")]}
        token = _EDGE.set(principal)
        try:
            await self.app(scope, receive, send)
        finally:
            _EDGE.reset(token)


class AgentTokenVerifier:
    """TokenVerifier (MCP SDK protocol): a LifeOS agent token as a bearer token, or the edge
    principal verified for this request."""

    def __init__(self, public_key_pem: Callable[[], str | None]) -> None:
        self._public_key = public_key_pem

    async def verify_token(self, token: str) -> AccessToken | None:
        edge = _EDGE.get()
        if edge is not None:
            return AccessToken(
                token=token,
                client_id=edge.subject,
                scopes=list(edge.scopes),
                subject=edge.subject,
                claims={"roles": list(edge.roles) if edge.roles else None, "via": edge.via},
            )
        key = self._public_key()
        if not key:
            return None
        try:
            context, claims = verify_claims(token, key)
        except AgentTokenError:
            return None
        return AccessToken(
            token=token,
            client_id=str(claims["sub"]),
            scopes=sorted(context.scopes),
            expires_at=int(claims["exp"]),
            subject=str(claims["sub"]),
            claims={"roles": claims.get("roles"), "via": "agent-token"},
        )
