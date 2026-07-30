"""Acceptance 4: history returns the full event trail for a mutated entity."""

from uuid import UUID

from kernel.access import AccessContext
from kernel.services import capture, history, latest_event_ids


def test_full_trail_for_mutated_entity(seeded: dict[str, UUID], ctx: AccessContext) -> None:
    first = capture(ctx, "person", {"full_name": "Trail Person", "emails": ["trail@history.test"]})
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


def test_latest_event_ids_cite_the_last_event_per_entity(
    seeded: dict[str, UUID], ctx: AccessContext
) -> None:
    """The provenance helper (ADR 010): one id per entity, and it is the LAST
    event — the state a derived read saw, not the opening capture."""
    first = capture(ctx, "person", {"full_name": "Cited Person", "emails": ["cited@history.test"]})
    capture(
        ctx,
        "person",
        {"full_name": "Cited Person", "emails": ["cited@history.test"], "birthday": "1991-03-04"},
    )
    events = history(ctx, first.entity_id)
    assert latest_event_ids(ctx, [first.entity_id]) == [str(events[-1].id)]
    assert latest_event_ids(ctx, []) == []
