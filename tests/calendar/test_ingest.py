"""Integration: ICS ingestion against the kernel (ADR 012, roadmap B1).

Tests in this module share the session database and run in definition order:
the double-run proof must precede the supersede test (which changes the
dentist appointment's stored hash). Fixture URLs differ per test so receipt
short-circuits never cross tests.
"""

import urllib.request
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from uuid import UUID

import pytest

from domains.calendar.ingest import (
    DERIVED_FROM,
    HAS_ATTENDEE,
    MAX_FEED_BYTES,
    METHOD,
    FeedReport,
    SameHostRedirects,
    ingest_content,
    ingest_context,
)
from domains.calendar.types import define_calendar_types
from kernel import db
from kernel.access import AccessContext, ScopeError
from kernel.services import find, forget, get_entity, history

FIXTURES = Path(__file__).parent / "fixtures"
WINDOW_START = datetime(2026, 7, 1, tzinfo=UTC)
WINDOW_END = datetime(2026, 9, 1, tzinfo=UTC)

BASE = (FIXTURES / "base.ics").read_bytes()
UPDATED = (FIXTURES / "updated.ics").read_bytes()


@pytest.fixture(scope="module")
def cal_ctx() -> AccessContext:
    """The exact production context: calendar read+write and nothing else."""
    ctx = ingest_context()
    define_calendar_types(ctx)
    return ctx


def ingest(ctx: AccessContext, content: bytes, url: str) -> FeedReport:
    return ingest_content(ctx, content, url, window_start=WINDOW_START, window_end=WINDOW_END)


def event_count() -> int:
    with db.connect() as conn:
        row = conn.execute("select count(*) as n from event").fetchone()
        assert row is not None
        return int(row["n"])


def test_ingest_creates_appointments_linked_to_receipt(cal_ctx: AccessContext) -> None:
    report = ingest(cal_ctx, BASE, "https://calendar.example.test/base.ics")
    assert report.created == 5  # dentist + berlin + 3 weekly occurrences
    assert report.skipped == 0 and not report.unchanged
    assert report.receipt_id is not None

    receipt = get_entity(cal_ctx, report.receipt_id)
    assert "source_receipt" in receipt.types
    assert receipt.entity.attributes["sha256"] == sha256(BASE).hexdigest()
    assert receipt.entity.attributes["size_bytes"] == len(BASE)
    assert receipt.entity.attributes["source_host"] == "calendar.example.test"
    assert "base.ics" not in str(receipt.entity.attributes)  # URL never stored
    # hash-plus-metadata only: no verbatim third-party text in the receipt
    assert "raw_ics" not in receipt.entity.attributes
    assert "dana@fixture.test" not in str(receipt.entity.attributes)

    for appointment in find(cal_ctx, type_name="appointment"):
        edges = get_entity(cal_ctx, appointment.id).edges_out
        derived = [e for e in edges if e.relation == DERIVED_FROM]
        assert derived, f"appointment {appointment.id} has no source receipt"
        assert derived[0].to_entity == report.receipt_id
        assert derived[0].attributes["method"] == METHOD
        assert derived[0].attributes["confidence"] == 1.0


def test_attendees_created_and_linked(cal_ctx: AccessContext) -> None:
    dentist = find(cal_ctx, type_name="appointment", filters={"uid": "dentist-1@fixture.test"})
    (appointment,) = dentist
    attendee_edges = [
        e for e in get_entity(cal_ctx, appointment.id).edges_out if e.relation == HAS_ATTENDEE
    ]
    emails = set()
    for edge in attendee_edges:
        attendee = get_entity(cal_ctx, edge.to_entity)
        assert "attendee" in attendee.types
        emails.add(attendee.entity.attributes["email"])
        assert any(e.relation == DERIVED_FROM for e in attendee.edges_out)
    assert emails == {"dana@fixture.test", "rob@fixture.test"}


def test_double_run_emits_nothing_new(cal_ctx: AccessContext) -> None:
    url = "https://calendar.example.test/double.ics"
    first = ingest(cal_ctx, BASE, url)
    assert not first.unchanged  # new URL -> new receipt on the first pass
    before = event_count()
    second = ingest(cal_ctx, BASE, url)
    assert second.unchanged
    assert second.created == second.updated == 0
    assert second.receipt_id == first.receipt_id
    assert event_count() == before  # zero new events, the idempotency proof


def test_updated_event_supersedes_earlier_state(cal_ctx: AccessContext) -> None:
    url = "https://calendar.example.test/supersede.ics"
    ingest(cal_ctx, BASE, url)
    others_before = {
        e.id: len(history(cal_ctx, e.id))
        for e in find(cal_ctx, type_name="appointment")
        if e.attributes["uid"] != "dentist-1@fixture.test"
    }
    report = ingest(cal_ctx, UPDATED, url)
    assert report.updated == 1 and report.created == 0  # only the dentist moved

    (dentist,) = find(cal_ctx, type_name="appointment", filters={"uid": "dentist-1@fixture.test"})
    assert dentist.attributes["title"] == "Dentist appointment (rescheduled)"
    assert dentist.attributes["starts_at"] == "2026-07-30T16:00:00+00:00"
    assert dentist.attributes["sequence"] == 1

    entity_events = [e for e in history(cal_ctx, dentist.id) if e.event_type.startswith("entity.")]
    assert [e.event_type for e in entity_events] == ["entity.created", "entity.updated"]
    assert entity_events[0].payload["entity"]["attributes"]["title"] == "Dentist appointment"

    # the new state cites the new receipt while the old receipt link survives
    receipts = {
        e.to_entity for e in get_entity(cal_ctx, dentist.id).edges_out if e.relation == DERIVED_FROM
    }
    assert report.receipt_id in receipts and len(receipts) >= 2

    for entity_id, count in others_before.items():
        assert len(history(cal_ctx, UUID(str(entity_id)))) == count  # untouched


def test_ingest_without_write_scope_fails_closed(cal_ctx: AccessContext) -> None:
    read_only = AccessContext.of("calendar:read")
    with pytest.raises(ScopeError):
        ingest(read_only, UPDATED, "https://calendar.example.test/scope.ics")


def test_oversized_feed_rejected(cal_ctx: AccessContext) -> None:
    with pytest.raises(ValueError, match="byte bound"):
        ingest(cal_ctx, b"x" * (MAX_FEED_BYTES + 1), "https://calendar.example.test/big.ics")


def test_non_http_source_rejected(cal_ctx: AccessContext) -> None:
    with pytest.raises(ValueError, match="http"):
        ingest(cal_ctx, BASE, "file:///C:/windows/whatever.ics")


def test_type_definition_is_idempotent_registry_data(cal_ctx: AccessContext) -> None:
    assert define_calendar_types(cal_ctx) == []  # second call defines nothing


def test_cross_host_redirect_refused() -> None:
    handler = SameHostRedirects("calendar.example.test")
    request = urllib.request.Request("https://calendar.example.test/feed.ics")
    with pytest.raises(ValueError, match="redirect"):
        handler.redirect_request(
            request, None, 302, "Found", {}, "http://169.254.169.254/latest/meta-data/"
        )
    with pytest.raises(ValueError, match="redirect"):  # scheme escape is refused too
        handler.redirect_request(
            request, None, 302, "Found", {}, "ftp://calendar.example.test/feed.ics"
        )


def test_same_host_redirect_allowed() -> None:
    handler = SameHostRedirects("calendar.example.test")
    request = urllib.request.Request("https://calendar.example.test/feed.ics")
    followed = handler.redirect_request(
        request, None, 302, "Found", {}, "https://calendar.example.test/moved.ics"
    )
    assert followed is not None
    assert followed.get_full_url() == "https://calendar.example.test/moved.ics"


# Runs last on purpose: forgetting rob's email removes the attendee's identity
# field, and earlier tests assert on the full attendee set.
def test_forgotten_attendee_email_unfindable_everywhere(cal_ctx: AccessContext) -> None:
    ingest(cal_ctx, BASE, "https://calendar.example.test/forget.ics")
    (rob,) = find(cal_ctx, type_name="attendee", filters={"email": "rob@fixture.test"})
    assert rob.id in {e.id for e in find(cal_ctx, text="rob@fixture.test")}  # not vacuous
    forget(cal_ctx, rob.id)
    # erased from live state, full-text search, and every receipt attribute
    assert find(cal_ctx, text="rob@fixture.test") == []
    assert "email" not in get_entity(cal_ctx, rob.id).entity.attributes
    for receipt in find(cal_ctx, type_name="source_receipt"):
        assert "rob@fixture.test" not in str(receipt.attributes)
