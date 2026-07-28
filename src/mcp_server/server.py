"""Read-only stdio MCP server: the first agent door, wrapping kernel
application services and nothing else (invariant 7, ADR 006/010).

The MCP client spawns this process with LIFEOS_AGENT_TOKEN and
LIFEOS_AGENT_JWT_PUBLIC_KEY in its environment; every tool call re-verifies
the token (so expiry holds for long-lived sessions) and goes through the
same AccessContext checks as the API. Results carry the provenance envelope
(ADR 010) — the ids each answer was built from, the producing method, and a
confidence, 1.0 here because every tool is a direct kernel read.
"""

from collections.abc import Iterable
from typing import Any
from uuid import UUID

from mcp.server.mcpserver import MCPServer

from kernel import services
from kernel.access import AccessContext
from kernel.env import read_env
from mcp_server.tokens import AgentTokenError, decode_key, verify

mcp = MCPServer(
    name="lifeos",
    instructions=(
        "Read-only access to the lifeos personal data kernel. The returned "
        "records are the only source of truth: answer strictly from them, cite "
        "the ids in each result's provenance, and when no record supports an "
        "answer say so plainly instead of guessing."
    ),
)


def access_context() -> AccessContext:
    """Build the AccessContext from the agent token in the environment.

    Fails closed: no token, no public key, bad signature, expiry, or any
    non-read scope refuses the call.
    """
    token = read_env("LIFEOS_AGENT_TOKEN")
    public_key = read_env("LIFEOS_AGENT_JWT_PUBLIC_KEY")
    if not token or not public_key:
        raise AgentTokenError(
            "LIFEOS_AGENT_TOKEN and LIFEOS_AGENT_JWT_PUBLIC_KEY must be set "
            "(mint: scripts/mint_agent_token.py; keys: README 'Agent access over MCP')"
        )
    return verify(token, decode_key(public_key))


def _provenance(
    method: str,
    entity_ids: Iterable[UUID] = (),
    event_ids: Iterable[UUID] = (),
) -> dict[str, Any]:
    return {
        "source_entity_ids": [str(i) for i in entity_ids],
        "source_event_ids": [str(i) for i in event_ids],
        "method": method,
        "confidence": 1.0,
    }


@mcp.tool()
def list_types() -> dict[str, Any]:
    """List the active type definitions (name, domain, JSON schema) readable
    with the current scopes. Call this first to learn what data can exist."""
    types = services.list_types(access_context())
    return {
        "types": [t.model_dump(mode="json") for t in types],
        "provenance": _provenance("kernel.list_types"),
    }


@mcp.tool()
def find(
    type_name: str | None = None,
    filters: dict[str, Any] | None = None,
    text: str | None = None,
) -> dict[str, Any]:
    """Search entities by type name, exact attribute filters, and/or full
    text. Results carry attributes only — relationships never appear here;
    call get_entity before claiming what an entity is or is not linked to.
    An empty result means no matching record exists — report that as
    'no data', never guess."""
    entities = services.find(access_context(), type_name=type_name, filters=filters, text=text)
    return {
        "entities": [e.model_dump(mode="json") for e in entities],
        "provenance": _provenance("kernel.find", entity_ids=[e.id for e in entities]),
    }


@mcp.tool()
def get_entity(entity_id: str) -> dict[str, Any]:
    """Fetch one entity with its types and active edges. This is current
    state only; superseded values appear solely in `history`."""
    view = services.get_entity(access_context(), UUID(entity_id))
    return {
        "entity_view": view.model_dump(mode="json"),
        "provenance": _provenance("kernel.get_entity", entity_ids=[view.entity.id]),
    }


@mcp.tool()
def history(entity_id: str) -> dict[str, Any]:
    """Full append-only event history for one entity — how its current state
    came to be, including superseded values."""
    events = services.history(access_context(), UUID(entity_id))
    return {
        "events": [e.model_dump(mode="json") for e in events],
        "provenance": _provenance(
            "kernel.history",
            entity_ids=[UUID(entity_id)],
            event_ids=[e.id for e in events],
        ),
    }


def main() -> None:
    access_context()  # refuse to serve at all on a bad or missing token
    mcp.run("stdio")
