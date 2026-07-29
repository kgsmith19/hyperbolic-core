"""Read-only stdio MCP server: the first agent door, wrapping kernel
application services and nothing else (invariant 7, ADR 006/010).

The MCP client spawns this process with LIFEOS_AGENT_TOKEN and
LIFEOS_AGENT_JWT_PUBLIC_KEY in its environment; every tool call re-verifies
the token (so expiry holds for long-lived sessions) and goes through the
same AccessContext checks as the API. The tool bodies live in
mcp_server.tools — the shared agent-tool surface the chat loop (ADR 011)
uses too; this module adds only token verification and MCP registration.
"""

from typing import Any

from mcp.server.mcpserver import MCPServer

from kernel.access import AccessContext
from kernel.env import read_env
from mcp_server import tools
from mcp_server.tokens import AgentTokenError, decode_key, verify

mcp = MCPServer(name="lifeos", instructions=tools.INSTRUCTIONS)


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


def list_types() -> dict[str, Any]:
    return tools.list_types(access_context())


def find(
    type_name: str | None = None,
    filters: dict[str, Any] | None = None,
    text: str | None = None,
) -> dict[str, Any]:
    return tools.find(access_context(), type_name=type_name, filters=filters, text=text)


def get_entity(entity_id: str) -> dict[str, Any]:
    return tools.get_entity(access_context(), entity_id)


def history(entity_id: str) -> dict[str, Any]:
    return tools.history(access_context(), entity_id)


for _tool in (list_types, find, get_entity, history):
    _tool.__doc__ = tools.DESCRIPTIONS[_tool.__name__]
    mcp.tool()(_tool)


def main() -> None:
    access_context()  # refuse to serve at all on a bad or missing token
    mcp.run("stdio")
