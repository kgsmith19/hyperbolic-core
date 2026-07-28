"""Integration: MCP tools against the seeded kernel — scoped reads,
provenance envelopes, and refusal of writes (ADR 010 acceptance)."""

import asyncio
from collections.abc import Callable
from uuid import UUID

import pytest

from kernel.access import ScopeError
from kernel.services import capture
from mcp_server import server
from mcp_server.tokens import AgentTokenError


def test_only_read_tools_are_exposed() -> None:
    tools = asyncio.run(server.mcp.list_tools())
    assert {t.name for t in tools} == {"list_types", "find", "get_entity", "history"}


def test_list_types_carries_provenance(
    seeded: dict[str, UUID], install_token: Callable[..., str]
) -> None:
    install_token("relationships:read", "health:read")
    result = server.list_types()
    assert {"person", "workout"} <= {t["name"] for t in result["types"]}
    assert result["provenance"]["method"] == "kernel.list_types"
    assert result["provenance"]["confidence"] == 1.0


def test_find_cites_the_entities_it_returns(
    seeded: dict[str, UUID], install_token: Callable[..., str]
) -> None:
    install_token("relationships:read", "health:read")
    result = server.find(type_name="workout")
    ids = {e["id"] for e in result["entities"]}
    assert {str(seeded["run"]), str(seeded["lift"])} <= ids
    assert set(result["provenance"]["source_entity_ids"]) == ids


def test_get_entity_and_history_cite_sources(
    seeded: dict[str, UUID], install_token: Callable[..., str]
) -> None:
    install_token("relationships:read", "health:read")
    person = str(seeded["person"])
    view = server.get_entity(person)
    assert view["entity_view"]["entity"]["id"] == person
    assert view["provenance"]["source_entity_ids"] == [person]
    events = server.history(person)
    assert events["events"]
    assert events["provenance"]["source_entity_ids"] == [person]
    assert events["provenance"]["source_event_ids"] == [e["id"] for e in events["events"]]


def test_token_scopes_are_enforced(
    seeded: dict[str, UUID], install_token: Callable[..., str]
) -> None:
    install_token("relationships:read")
    with pytest.raises(ScopeError, match="health:read"):
        server.find(type_name="workout")


def test_write_scoped_call_is_refused(
    seeded: dict[str, UUID], install_token: Callable[..., str]
) -> None:
    """Acceptance: the agent context cannot reach any write service."""
    install_token("relationships:read", "health:read")
    with pytest.raises(ScopeError, match="health:write"):
        capture(
            server.access_context(),
            "workout",
            {"kind": "walk", "started_at": "2026-07-28T09:00:00+00:00"},
        )


def test_fails_closed_without_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LIFEOS_AGENT_TOKEN", raising=False)
    with pytest.raises(AgentTokenError, match="must be set"):
        server.access_context()
