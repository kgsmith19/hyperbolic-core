"""Acceptance 3 + resolver behaviors: MATCH, NEW, AMBIGUOUS (invariant 4)."""

from uuid import UUID

from kernel.access import AccessContext
from kernel.resolution import Resolution
from kernel.services import capture, get_entity, history


def test_same_email_resolves_to_existing_entity(
    seeded: dict[str, UUID], ctx: AccessContext
) -> None:
    result = capture(
        ctx,
        "person",
        {"full_name": "Kyle G. Smith", "emails": ["kylegsmith19@gmail.com"]},
    )
    assert result.resolution is Resolution.MATCH
    assert result.entity_id == seeded["person"]
    view = get_entity(ctx, result.entity_id)
    assert view.entity.attributes["full_name"] == "Kyle G. Smith"


def test_no_identity_fields_always_new(seeded: dict[str, UUID], ctx: AccessContext) -> None:
    attrs = {"kind": "row", "started_at": "2026-07-23T06:00:00+00:00"}
    first = capture(ctx, "workout", attrs)
    second = capture(ctx, "workout", attrs)
    assert first.resolution is Resolution.NEW
    assert second.resolution is Resolution.NEW
    assert first.entity_id != second.entity_id


def test_ambiguous_creates_new_and_flags(seeded: dict[str, UUID], ctx: AccessContext) -> None:
    a = capture(ctx, "person", {"full_name": "A", "emails": ["a@amb.test"]})
    b = capture(ctx, "person", {"full_name": "B", "emails": ["b@amb.test"]})
    both = capture(
        ctx, "person", {"full_name": "AB?", "emails": ["a@amb.test", "b@amb.test"]}
    )
    assert both.resolution is Resolution.AMBIGUOUS
    assert both.entity_id not in {a.entity_id, b.entity_id}
    events = history(ctx, both.entity_id)
    ambiguity = [e for e in events if e.event_type == "resolution.ambiguity"]
    assert len(ambiguity) == 1
    assert set(ambiguity[0].payload["candidates"]) == {str(a.entity_id), str(b.entity_id)}
