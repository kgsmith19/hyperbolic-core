"""Remote MCP transport (streamable HTTP): the same agent door as the stdio server, reachable
by any harness that speaks MCP over HTTP (ChatGPT, Claude, Codex, Cursor, ...).

The server is an OAuth 2.1 *resource server* (MCP authorization spec): it publishes RFC 9728
protected-resource metadata naming the authorization server, answers an unauthenticated call
with 401 + `WWW-Authenticate: resource_metadata=...`, and never issues tokens itself. Which
authorization server and which edge proxy are configuration, not code (mcp_server.ingress).

Tools: the four read-only tools of the stdio server, plus `request_decision`, which asks the
role gate for one decision exactly like POST /agents/requests (#596): requested_by is the
verified caller, the role must be in its allowlist, `approved` cannot be sent, and nothing is
executed.

    python -m mcp_server --http [--host 127.0.0.1] [--port 8090]

Environment:
    LIFEOS_MCP_RESOURCE_URL      public URL of this server, e.g. https://core.example.com/life/mcp
    LIFEOS_MCP_AUTH_ISSUER       the OAuth authorization server's issuer URL
    LIFEOS_AGENT_JWT_PUBLIC_KEY  verifies LifeOS agent tokens (bearer)
    LIFEOS_MCP_EDGE              "none" (default) or "cloudflare-access"
    LIFEOS_MCP_EDGE_TEAM_DOMAIN, LIFEOS_MCP_EDGE_AUD   edge adapter settings
    LIFEOS_MCP_EDGE_SCOPES, LIFEOS_MCP_EDGE_ROLES      comma lists granted to an edge identity
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.settings import AuthSettings
from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import AnyHttpUrl

from domains.agents.requests import parse_role
from domains.agents.requests import request as request_gate_decision
from domains.agents.roles import default_registry
from kernel.access import AccessContext
from kernel.env import read_env
from mcp_server import tools
from mcp_server.ingress import (
    AgentTokenVerifier,
    CloudflareAccessEdge,
    EdgeIdentity,
    EdgeIdentityMiddleware,
)
from mcp_server.tokens import AgentTokenError, decode_key, read_scopes

REQUEST_DECISION_DOC = (
    "Ask the LifeOS role gate for one decision as one of your allowed roles. Returns the "
    "durable receipt: allowed or denied, the reason, and the action class. Nothing is "
    "executed and nothing is approved; a retry with the same idempotency_key returns the "
    "original receipt."
)


@dataclass(frozen=True)
class HttpSettings:
    resource_url: str
    issuer_url: str
    edge: str = "none"
    edge_team_domain: str = ""
    edge_aud: str = ""
    edge_scopes: tuple[str, ...] = ()
    edge_roles: tuple[str, ...] = ()

    @classmethod
    def from_env(cls, env: Callable[[str], str | None] = read_env) -> HttpSettings:
        def items(name: str) -> tuple[str, ...]:
            return tuple(x.strip() for x in (env(name) or "").split(",") if x.strip())

        resource, issuer = env("LIFEOS_MCP_RESOURCE_URL"), env("LIFEOS_MCP_AUTH_ISSUER")
        if not resource or not issuer:
            raise AgentTokenError("LIFEOS_MCP_RESOURCE_URL and LIFEOS_MCP_AUTH_ISSUER must be set")
        return cls(
            resource_url=resource,
            issuer_url=issuer,
            edge=env("LIFEOS_MCP_EDGE") or "none",
            edge_team_domain=env("LIFEOS_MCP_EDGE_TEAM_DOMAIN") or "",
            edge_aud=env("LIFEOS_MCP_EDGE_AUD") or "",
            edge_scopes=items("LIFEOS_MCP_EDGE_SCOPES"),
            edge_roles=items("LIFEOS_MCP_EDGE_ROLES"),
        )


def edge_for(
    settings: HttpSettings, jwks: Callable[[str], Any] | None = None
) -> EdgeIdentity | None:
    if settings.edge == "none":
        return None
    if settings.edge == "cloudflare-access":
        return CloudflareAccessEdge(
            settings.edge_team_domain,
            settings.edge_aud,
            settings.edge_scopes,
            settings.edge_roles or None,
            jwks=jwks,
        )
    raise AgentTokenError(f"unknown LIFEOS_MCP_EDGE {settings.edge!r}")


def _caller() -> tuple[AccessContext, str, tuple[str, ...] | None]:
    """The verified caller of this request: its context, subject and role allowlist."""
    token = get_access_token()
    if token is None or not token.subject:
        raise AgentTokenError("no verified caller on this request")
    context = AccessContext(scopes=read_scopes(token.scopes))
    roles = (token.claims or {}).get("roles")
    return context, token.subject, tuple(roles) if roles else None


def list_types() -> dict[str, Any]:
    return tools.list_types(_caller()[0])


def find(
    type_name: str | None = None,
    filters: dict[str, Any] | None = None,
    text: str | None = None,
) -> dict[str, Any]:
    return tools.find(_caller()[0], type_name=type_name, filters=filters, text=text)


def get_entity(entity_id: str) -> dict[str, Any]:
    return tools.get_entity(_caller()[0], entity_id)


def history(entity_id: str) -> dict[str, Any]:
    return tools.history(_caller()[0], entity_id)


def request_decision(role: str, permission: str, idempotency_key: str) -> dict[str, Any]:
    context, subject, roles = _caller()
    result = request_gate_decision(
        context,
        default_registry(),
        parse_role(role),
        permission,
        idempotency_key,
        requested_by=subject,
        allowed_roles=roles if roles is not None else (),
    )
    receipt = result.receipt
    return {
        "receipt_key": receipt.receipt_key,
        "role": receipt.role,
        "permission": receipt.permission,
        "action_class": receipt.action_class,
        "allowed": receipt.allowed,
        "reason": receipt.reason,
        "recorded_at": receipt.recorded_at,
        "duplicate": receipt.duplicate,
        "requested_by": result.requested_by,
        "executed": False,
    }


def build_server(settings: HttpSettings, public_key: Callable[[], str | None]) -> MCPServer:
    server = MCPServer(
        name="lifeos",
        instructions=tools.INSTRUCTIONS,
        token_verifier=AgentTokenVerifier(public_key),
        auth=AuthSettings(
            issuer_url=AnyHttpUrl(settings.issuer_url),
            resource_server_url=AnyHttpUrl(settings.resource_url),
            # Each verifier checks its own audience: agent tokens aud=lifeos-mcp, the edge its AUD.
            validate_token_resource=False,
        ),
    )
    for tool in (list_types, find, get_entity, history):
        tool.__doc__ = tools.DESCRIPTIONS[tool.__name__]
        server.tool()(tool)
    request_decision.__doc__ = REQUEST_DECISION_DOC
    server.tool()(request_decision)
    return server


def build_app(
    settings: HttpSettings,
    public_key: Callable[[], str | None] | None = None,
    jwks: Callable[[str], Any] | None = None,
) -> Any:
    """The ASGI app: the MCP streamable-HTTP app (stateless, JSON responses: every request
    carries its own credential), wrapped by the edge adapter when one is configured."""

    def key() -> str | None:
        raw = read_env("LIFEOS_AGENT_JWT_PUBLIC_KEY")
        return decode_key(raw) if raw else None

    # DNS-rebinding guard: only the public host this server is published at (plus loopback
    # for local runs) may appear in Host; browsers' Origin must match it too.
    public = urlsplit(settings.resource_url)
    security = TransportSecuritySettings(
        allowed_hosts=[public.netloc, "127.0.0.1:*", "localhost:*"],
        allowed_origins=[f"{public.scheme}://{public.netloc}"],
    )
    app = build_server(settings, public_key or key).streamable_http_app(
        stateless_http=True, json_response=True, transport_security=security
    )
    edge = edge_for(settings, jwks)
    return EdgeIdentityMiddleware(app, edge) if edge is not None else app


def main(host: str, port: int, env: Mapping[str, str] | None = None) -> None:
    import uvicorn

    uvicorn.run(build_app(HttpSettings.from_env()), host=host, port=port)
