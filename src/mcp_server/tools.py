"""The shared agent-tool surface (ADR 010/011): the four provenance-wrapped
read tools both agent doors use — the MCP server registers them as MCP tools,
the chat loop passes them to the model as Anthropic tools. One implementation,
two doors (invariant 7: everything goes through kernel services).
"""

from collections.abc import Callable, Iterable
from typing import Any
from uuid import UUID

from kernel import services
from kernel.access import AccessContext

INSTRUCTIONS = (
    "Read-only access to the lifeos personal data kernel. The returned "
    "records are the only source of truth: answer strictly from them, cite "
    "the ids in each result's provenance, and when no record supports an "
    "answer say so plainly instead of guessing."
)

DESCRIPTIONS = {
    "list_types": (
        "List the active type definitions (name, domain, JSON schema) readable "
        "with the current scopes. Call this first to learn what data can exist."
    ),
    "find": (
        "Search entities by type name, exact attribute filters, and/or full "
        "text. Results carry attributes only — relationships never appear here; "
        "call get_entity before claiming what an entity is or is not linked to. "
        "An empty result means no matching record exists — report that as "
        "'no data', never guess."
    ),
    "get_entity": (
        "Fetch one entity with its types and active edges. This is current "
        "state only; superseded values appear solely in `history`."
    ),
    "history": (
        "Full append-only event history for one entity — how its current state "
        "came to be, including superseded values."
    ),
}


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


def list_types(ctx: AccessContext) -> dict[str, Any]:
    types = services.list_types(ctx)
    return {
        "types": [t.model_dump(mode="json") for t in types],
        "provenance": _provenance("kernel.list_types"),
    }


def find(
    ctx: AccessContext,
    type_name: str | None = None,
    filters: dict[str, Any] | None = None,
    text: str | None = None,
) -> dict[str, Any]:
    entities = services.find(ctx, type_name=type_name, filters=filters, text=text)
    return {
        "entities": [e.model_dump(mode="json") for e in entities],
        "provenance": _provenance("kernel.find", entity_ids=[e.id for e in entities]),
    }


def get_entity(ctx: AccessContext, entity_id: str) -> dict[str, Any]:
    view = services.get_entity(ctx, UUID(entity_id))
    return {
        "entity_view": view.model_dump(mode="json"),
        "provenance": _provenance("kernel.get_entity", entity_ids=[view.entity.id]),
    }


def history(ctx: AccessContext, entity_id: str) -> dict[str, Any]:
    events = services.history(ctx, UUID(entity_id))
    return {
        "events": [e.model_dump(mode="json") for e in events],
        "provenance": _provenance(
            "kernel.history",
            entity_ids=[UUID(entity_id)],
            event_ids=[e.id for e in events],
        ),
    }


# Anthropic tool definitions for the chat loop (strict shapes; the MCP door
# derives its schemas from the wrapper signatures in server.py instead).
AGENT_TOOLS: list[dict[str, Any]] = [
    {
        "name": "list_types",
        "description": DESCRIPTIONS["list_types"],
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "find",
        "description": DESCRIPTIONS["find"],
        "input_schema": {
            "type": "object",
            "properties": {
                "type_name": {"type": "string"},
                "filters": {"type": "object"},
                "text": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_entity",
        "description": DESCRIPTIONS["get_entity"],
        "input_schema": {
            "type": "object",
            "properties": {"entity_id": {"type": "string"}},
            "required": ["entity_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "history",
        "description": DESCRIPTIONS["history"],
        "input_schema": {
            "type": "object",
            "properties": {"entity_id": {"type": "string"}},
            "required": ["entity_id"],
            "additionalProperties": False,
        },
    },
]

_RUNNERS: dict[str, Callable[..., dict[str, Any]]] = {
    "list_types": list_types,
    "find": find,
    "get_entity": get_entity,
    "history": history,
}


def run_tool(ctx: AccessContext, name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one agent tool call. Unknown names are a client error."""
    runner = _RUNNERS.get(name)
    if runner is None:
        raise ValueError(f"unknown tool: {name}")
    return runner(ctx, **args)
