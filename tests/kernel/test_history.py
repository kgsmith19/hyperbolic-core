"""Acceptance 4: history returns the full event trail for a mutated entity."""

from uuid import UUID

from kernel.access import AccessContext
from kernel.services import capture, history


def test_full_trail_for_mutated_entity(seeded: dict[str, UUID], ctx: AccessContext) -> None:
    first = capture(
        ctx, "person", {"full_name": "Trail Person", "emails": ["trail@history.test"]}
    )
    second = capture(
        ctx,
        "person",
        {"full_name": "Trail Person", "emails": ["trail@history.test"], "birthday": "1990-01-02"},
    )
    assert second.entity_id == first.entity_id

    events = history(ctx, first.entity_id)
    assert [e.event_type for e in events] == ["entity.created", "entity.updated"]
    assert "birthday" not in events[0].payload["entity"]["attributes"]
    assert events[1].payload["entity"]["attributes"]["birthday"] == "1990-01-02"
    assert all(e.actor == "kyle" for e in events)
