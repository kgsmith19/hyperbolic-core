"""E2E: a real MCP client over stdio to a spawned server process — the same
transport an MCP client (e.g. Claude Desktop) uses."""

import json
import os
import sys
from collections.abc import Callable
from typing import Any
from uuid import UUID

import anyio
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.types import TextContent


def test_stdio_round_trip(
    seeded: dict[str, UUID], install_token: Callable[..., str]
) -> None:
    install_token("relationships:read", "health:read")
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "mcp_server"],
        env={**os.environ},
    )

    async def run() -> tuple[set[str], dict[str, Any]]:
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = {t.name for t in (await session.list_tools()).tools}
                result = await session.call_tool("find", {"type_name": "workout"})
                assert not result.is_error
                content = result.content[0]
                assert isinstance(content, TextContent)
                payload = result.structured_content or json.loads(content.text)
                return tools, payload

    tools, payload = anyio.run(run)
    assert tools == {"list_types", "find", "get_entity", "history"}
    assert str(seeded["run"]) in {e["id"] for e in payload["entities"]}
    assert payload["provenance"]["method"] == "kernel.find"
