"""Acceptance 6 + unit: scope-shaped access control (invariant 5)."""

from uuid import UUID

import pytest

from kernel.access import AccessContext, ScopeError, require
from kernel.services import capture, define_type, find, get_entity


def test_missing_health_read_cannot_find_workouts(seeded: object) -> None:
    partial = AccessContext.of("relationships:read", "relationships:write")
    with pytest.raises(ScopeError, match="health:read"):
        find(partial, type_name="workout")


def test_missing_write_cannot_capture(seeded: object) -> None:
    read_only = AccessContext.of("health:read")
    with pytest.raises(ScopeError, match="health:write"):
        capture(read_only, "workout", {"kind": "walk", "started_at": "2026-07-23T09:00:00+00:00"})


def test_typed_find_hides_entities_spanning_unreadable_domains(
    seeded: object, ctx: AccessContext
) -> None:
    """A multi-domain entity must not leak through a typed find when the
    caller cannot read every domain it belongs to (same rule as get_entity)."""
    define_type(
        ctx,
        "client",
        "work",
        {
            "type": "object",
            "properties": {"emails": {"type": "array", "items": {"type": "string"}}},
            "x-identity": ["emails"],
        },
    )
    capture(ctx, "person", {"full_name": "Span Man", "emails": ["span@scope.test"]})
    merged = capture(ctx, "client", {"emails": ["span@scope.test"]})

    rel_only = AccessContext.of("relationships:read")
    assert merged.entity_id not in {e.id for e in find(rel_only, type_name="person")}
    assert merged.entity_id in {e.id for e in find(ctx, type_name="person")}


def test_get_entity_hides_edges_into_unreadable_domains(
    seeded: dict[str, UUID], ctx: AccessContext
) -> None:
    """An edge is visible only when every domain of its other endpoint is
    readable (same rule as find) — otherwise a health-scoped agent would see
    relationship edges it was never granted."""
    health_only = AccessContext.of("health:read")
    run_id = seeded["run"]
    assert "performed_by" in {e.relation for e in get_entity(ctx, run_id).edges_out}
    assert "performed_by" not in {e.relation for e in get_entity(health_only, run_id).edges_out}


def test_require_unit() -> None:
    require(AccessContext.all(), "anything:read")
    require(AccessContext.of("health:read"), "health:read")
    with pytest.raises(ScopeError):
        require(AccessContext.of("health:read"), "health:write")
