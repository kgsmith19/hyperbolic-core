"""Integration: trigger_feedback — a human's verdict on a scheduled output
(ADR 014). Nothing writes it automatically; this is the service a UI would call.

The erasure test runs last because it strips the note it searches for.
"""

from datetime import UTC, date
from uuid import UUID, uuid4

import jsonschema
import pytest

from domains.ops.briefing import briefing_context, run_briefing
from domains.ops.feedback import VERDICTS, feedback_context, record_feedback
from domains.ops.types import define_ops_types
from kernel.access import AccessContext, ScopeError
from kernel.services import capture, find, forget, get_entity, history
from scripts.define_daily_checkin import define_daily_checkin

DAY = date(2031, 4, 9)
NOTE_NAME = "Marlowe Quinceberry"


@pytest.fixture(scope="module")
def briefing_id(ctx: AccessContext) -> UUID:
    """A real produced entity to judge; `ctx` (all scopes) only arranges data."""
    define_daily_checkin(ctx)
    define_ops_types(feedback_context())
    return run_briefing(briefing_context(), DAY, UTC).briefing_id


def test_verdicts_are_the_three_the_adr_names() -> None:
    assert VERDICTS == ("useful", "noise", "wrong")


def test_records_a_verdict_against_the_briefing(briefing_id: UUID) -> None:
    ctx = feedback_context()
    feedback = record_feedback(ctx, briefing_id, "noise", note="nothing on today")

    attributes = get_entity(ctx, feedback).entity.attributes
    assert attributes["subject_id"] == str(briefing_id)
    assert attributes["verdict"] == "noise"
    assert attributes["note"] == "nothing on today"


def test_rejudging_supersedes_instead_of_duplicating(briefing_id: UUID) -> None:
    ctx = feedback_context()
    feedback = record_feedback(ctx, briefing_id, "useful")

    assert get_entity(ctx, feedback).entity.attributes["verdict"] == "useful"
    events = [e.event_type for e in history(ctx, feedback)]
    assert events[0] == "entity.created" and "entity.updated" in events
    # one standing verdict per subject; the earlier one stays in the log
    standing = find(ctx, type_name="trigger_feedback", filters={"subject_id": str(briefing_id)})
    assert len(standing) == 1


def test_unknown_verdict_is_rejected(briefing_id: UUID) -> None:
    with pytest.raises(jsonschema.ValidationError):
        record_feedback(feedback_context(), briefing_id, "meh")


def test_unknown_subject_is_rejected(briefing_id: UUID) -> None:
    with pytest.raises(LookupError):
        record_feedback(feedback_context(), uuid4(), "useful")


def test_feedback_without_ops_write_fails_closed(briefing_id: UUID) -> None:
    with pytest.raises(ScopeError):
        record_feedback(AccessContext.of("ops:read"), briefing_id, "wrong")


# Runs last on purpose: it erases the note the assertions search for.
def test_note_is_pii_and_erasable(ctx: AccessContext, briefing_id: UUID) -> None:
    other = capture(
        ctx,
        "daily_checkin",
        {"date": "2031-04-10", "mood": 3, "energy": 3, "stress": 3, "sleep_quality": 3},
    ).entity_id
    feedback = record_feedback(ctx, other, "wrong", note=f"{NOTE_NAME} was not in this meeting")
    assert feedback in {e.id for e in find(ctx, text=NOTE_NAME)}  # not vacuous

    forget(ctx, feedback)

    assert find(ctx, text=NOTE_NAME) == []
    attributes = get_entity(ctx, feedback).entity.attributes
    assert "note" not in attributes
    assert attributes["verdict"] == "wrong"  # the verdict itself survives erasure
    for event in history(ctx, feedback):
        assert NOTE_NAME not in str(event.payload)
