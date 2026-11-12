"""Completion evidence for intentions (Q5): DONE is never inferred from silence.

Each DONE write path is tested: the progress path, the mark-done path, and the
generic capture door. Existing DONE rows are grandfathered, not refused.
"""

from uuid import uuid4

import pytest

from domains.intentions.focus import capture_intention
from domains.intentions.planner import mark_done
from domains.intentions.today import set_progress
from domains.intentions.types import TYPE_NAME, define_intention_types
from kernel import services
from kernel.access import AccessContext


@pytest.fixture(scope="module")
def seed_ctx(ctx: AccessContext) -> AccessContext:
    define_intention_types(ctx)
    return ctx


def _title() -> str:
    return f"done-evidence-{uuid4().hex[:10]}"


def _seed(ctx: AccessContext, title: str) -> object:
    capture_intention(ctx, {"title": title, "kind": "task", "status": "active", "focus": False})
    return next(
        e.id for e in services.find(ctx, type_name=TYPE_NAME) if e.attributes["title"] == title
    )


def test_progress_to_done_without_evidence_is_refused(seed_ctx: AccessContext) -> None:
    eid = _seed(seed_ctx, _title())

    with pytest.raises(ValueError, match="evidence"):
        set_progress(seed_ctx, eid, "DONE")


def test_progress_to_done_with_evidence_is_accepted_and_recorded(seed_ctx: AccessContext) -> None:
    eid = _seed(seed_ctx, _title())

    item = set_progress(seed_ctx, eid, "DONE", evidence="  bank confirmation  ")
    entity = services.get_entity(seed_ctx, eid).entity

    assert item.progress == "DONE"
    assert entity.attributes["completion_evidence"] == "bank confirmation"


def test_mark_done_without_evidence_is_refused_and_writes_nothing(seed_ctx: AccessContext) -> None:
    eid = _seed(seed_ctx, _title())
    before = len(services.history(seed_ctx, eid))

    with pytest.raises(ValueError, match="evidence"):
        mark_done(seed_ctx, eid)

    assert len(services.history(seed_ctx, eid)) == before


def test_blank_evidence_is_refused_like_missing_evidence(seed_ctx: AccessContext) -> None:
    eid = _seed(seed_ctx, _title())

    with pytest.raises(ValueError, match="evidence"):
        mark_done(seed_ctx, eid, evidence="   ")


def test_an_already_done_row_is_grandfathered_when_edited_again(seed_ctx: AccessContext) -> None:
    title = _title()
    # A legacy row written before the rule existed, below the new door.
    services.capture(
        seed_ctx,
        TYPE_NAME,
        {"title": title, "kind": "task", "status": "active", "focus": False, "done": True},
        actor="test",
    )
    eid = next(
        e.id for e in services.find(seed_ctx, type_name=TYPE_NAME) if e.attributes["title"] == title
    )

    # Editing a row that is already DONE must not start failing.
    result = mark_done(seed_ctx, eid)

    assert result is not None


def test_the_generic_capture_door_refuses_done_without_evidence(seed_ctx: AccessContext) -> None:
    with pytest.raises(ValueError, match="evidence"):
        capture_intention(
            seed_ctx,
            {"title": _title(), "kind": "task", "status": "active", "focus": False, "done": True},
        )


def test_the_generic_capture_door_accepts_done_with_evidence(seed_ctx: AccessContext) -> None:
    title = _title()
    capture_intention(
        seed_ctx,
        {
            "title": title,
            "kind": "task",
            "status": "active",
            "focus": False,
            "done": True,
            "completion_evidence": "owner confirmed",
        },
    )

    found = [
        e for e in services.find(seed_ctx, type_name=TYPE_NAME) if e.attributes["title"] == title
    ]
    assert found and found[0].attributes["done"] is True
