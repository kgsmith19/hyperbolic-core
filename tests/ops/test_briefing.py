"""Integration: the assembled daily briefing (ADR 014, roadmap B3).

Everything here is synthetic and dated far from the calendar fixtures, so the
day under test contains exactly what each test put there.
"""

from datetime import UTC, date, datetime, timedelta, timezone
from hashlib import sha256
from typing import Any
from uuid import UUID

import pytest

from domains.calendar.types import define_calendar_types, email_hash
from domains.ops.briefing import (
    METHOD,
    _optional_find,
    assemble,
    briefing_context,
    main,
    run_briefing,
)
from domains.ops.types import define_ops_types
from kernel import db
from kernel.access import AccessContext, ScopeError
from kernel.services import capture, find, history
from scripts.define_daily_checkin import define_daily_checkin

DAY = date(2031, 3, 4)
EMPTY_DAY = date(2031, 3, 7)
DROP_DAY = date(2031, 5, 2)
TITLE = "Quarterly review with the accountant"


@pytest.fixture(scope="module")
def brief_ctx(ctx: AccessContext) -> AccessContext:
    """The exact production context; `ctx` (all scopes) only arranges data."""
    define_calendar_types(ctx)
    define_daily_checkin(ctx)
    context = briefing_context()
    define_ops_types(context)
    return context


def make_appointment(ctx: AccessContext, key: str, starts_at: str) -> UUID:
    return capture(
        ctx,
        "appointment",
        {
            "ics_key": key,
            "uid": key,
            "title": TITLE,
            "starts_at": starts_at,
            "vevent_hash": sha256(key.encode()).hexdigest(),
        },
    ).entity_id


def event_count() -> int:
    with db.connect() as conn:
        row = conn.execute("select count(*) as n from event").fetchone()
        assert row is not None
        return int(row["n"])


def stored(ctx: AccessContext, day: date) -> dict[str, Any]:
    (briefing,) = find(ctx, type_name="briefing", filters={"briefing_key": day.isoformat()})
    return {"id": briefing.id, **briefing.attributes}


def test_briefing_lists_todays_appointments_chronologically(
    ctx: AccessContext, brief_ctx: AccessContext
) -> None:
    late = make_appointment(ctx, "brief-late", "2031-03-04T16:00:00+00:00")
    early = make_appointment(ctx, "brief-early", "2031-03-04T09:00:00+00:00")
    make_appointment(ctx, "brief-tomorrow", "2031-03-05T09:00:00+00:00")

    report = run_briefing(brief_ctx, DAY, UTC)

    assert report.appointments == 2 and not report.unchanged
    assert stored(brief_ctx, DAY)["appointment_ids"] == [str(early), str(late)]


def test_briefing_cites_reviews_checkin_and_provenance(
    ctx: AccessContext, brief_ctx: AccessContext
) -> None:
    review = capture(
        ctx,
        "link_review",
        {
            "review_key": "briefing-fixture:ambiguous_email_match",
            "attendee_id": str(UUID(int=7)),
            "candidate_person_ids": [],
            "reason": "ambiguous_email_match",
        },
    ).entity_id
    checkin = capture(
        ctx,
        "daily_checkin",
        {"date": "2031-03-04", "mood": 4, "energy": 4, "stress": 2, "sleep_quality": 4},
    ).entity_id

    run_briefing(brief_ctx, DAY, UTC)
    attributes = stored(brief_ctx, DAY)

    assert str(review) in attributes["open_review_ids"]
    assert attributes["latest_checkin_id"] == str(checkin)  # the most recent one
    provenance = attributes["provenance"]
    assert provenance["method"] == METHOD and provenance["confidence"] == 1.0
    assert str(checkin) in provenance["source_entity_ids"]
    # every cited entity contributes the event that produced the state we saw
    assert len(provenance["source_event_ids"]) == len(provenance["source_entity_ids"])


def test_briefing_copies_no_third_party_text(ctx: AccessContext, brief_ctx: AccessContext) -> None:
    witness = "briefing-witness@fixture.test"
    capture(
        ctx, "attendee", {"email_hash": email_hash(witness), "email": witness, "name": "B Witness"}
    )
    make_appointment(ctx, "brief-pii", "2031-03-04T11:00:00+00:00")
    run_briefing(brief_ctx, DAY, UTC)
    briefing = stored(brief_ctx, DAY)

    # IDs, never the text they point at: a copied title would survive the
    # erasure of its appointment (invariant 9, ADR 012/014)
    body = str({k: v for k, v in briefing.items() if k != "id"})
    assert TITLE not in body
    assert "briefing-witness@fixture.test" not in body
    # and the briefing never surfaces on the appointment's own text search
    assert briefing["id"] not in {e.id for e in find(brief_ctx, text=TITLE)}


def test_rerun_with_unchanged_inputs_emits_nothing(brief_ctx: AccessContext) -> None:
    run_briefing(brief_ctx, DAY, UTC)
    before = event_count()
    report = run_briefing(brief_ctx, DAY, UTC)
    assert report.unchanged
    assert event_count() == before  # the idempotency proof


def test_new_appointment_updates_the_same_briefing(
    ctx: AccessContext, brief_ctx: AccessContext
) -> None:
    first = run_briefing(brief_ctx, DAY, UTC)
    make_appointment(ctx, "brief-added", "2031-03-04T20:00:00+00:00")

    second = run_briefing(brief_ctx, DAY, UTC)

    assert second.briefing_id == first.briefing_id and not second.unchanged
    assert second.appointments == first.appointments + 1
    events = [e.event_type for e in history(brief_ctx, second.briefing_id)]
    assert events[0] == "entity.created" and "entity.updated" in events  # supersede, not overwrite


def test_local_timezone_decides_the_day(ctx: AccessContext, brief_ctx: AccessContext) -> None:
    # 01:30 UTC on the 6th is still the evening of the 5th, five hours west
    appointment = make_appointment(ctx, "brief-tz", "2031-03-06T01:30:00+00:00")
    west = timezone(timedelta(hours=-5))

    assert str(appointment) in assemble(brief_ctx, date(2031, 3, 5), west)["appointment_ids"]
    assert str(appointment) not in assemble(brief_ctx, date(2031, 3, 6), west)["appointment_ids"]
    assert str(appointment) in assemble(brief_ctx, date(2031, 3, 6), UTC)["appointment_ids"]


def test_absent_type_is_an_empty_section_not_a_crash(brief_ctx: AccessContext) -> None:
    assert _optional_find(brief_ctx, "no_such_type_yet") == []


def test_briefing_cannot_write_what_it_reads(brief_ctx: AccessContext) -> None:
    with pytest.raises(ScopeError):  # read-only on calendar by construction
        make_appointment(brief_ctx, "brief-forbidden", "2031-03-04T12:00:00+00:00")


def test_briefing_without_ops_write_fails_closed() -> None:
    read_only = AccessContext.of("calendar:read", "wellbeing:read", "ops:read")
    with pytest.raises(ScopeError):
        run_briefing(read_only, EMPTY_DAY, UTC)


def test_a_key_assemble_stops_emitting_stays_idempotent(
    ctx: AccessContext, brief_ctx: AccessContext
) -> None:
    """capture MERGES on identity, so `latest_checkin_id` lingers on the stored
    briefing after assemble stops emitting it — comparing whole attribute dicts
    would make the run re-capture forever."""
    capture(
        ctx,
        "daily_checkin",
        {"date": "2031-05-02", "mood": 3, "energy": 3, "stress": 3, "sleep_quality": 3},
    )
    assert run_briefing(brief_ctx, DROP_DAY, UTC).has_checkin

    # the same day seen without wellbeing:read: no check-in, so no key
    blind = AccessContext.of("calendar:read", "ops:read", "ops:write")
    second = run_briefing(blind, DROP_DAY, UTC)
    assert not second.unchanged and not second.has_checkin

    before = event_count()
    assert run_briefing(blind, DROP_DAY, UTC).unchanged
    assert event_count() == before


def test_cli_emits_an_execution_receipt(brief_ctx: AccessContext) -> None:
    assert main() == 0
    receipts = find(brief_ctx, type_name="execution_receipt", filters={"job": METHOD})
    assert receipts and receipts[-1].attributes["status"] == "ok"
    today = datetime.now(UTC).date().isoformat()
    assert receipts[-1].attributes["summary"].startswith(f"briefing {today}")
