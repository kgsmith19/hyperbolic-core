"""Unit: ICS parsing — recurrence, timezones, identity/hash stability, and
untrusted-input bounds (skip-with-count, expansion cap, garbage rejection)."""

from datetime import UTC, datetime
from pathlib import Path

import pytest

from domains.calendar.parse import MAX_OCCURRENCES, ParsedFeed, parse_ics

FIXTURES = Path(__file__).parent / "fixtures"
WINDOW_START = datetime(2026, 7, 1, tzinfo=UTC)
WINDOW_END = datetime(2026, 9, 1, tzinfo=UTC)


def load(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def parse(name: str) -> ParsedFeed:
    return parse_ics(load(name), WINDOW_START, WINDOW_END)


def test_recurrence_expands_to_keyed_occurrences() -> None:
    parsed = parse("base.ics")
    weekly = [o for o in parsed.occurrences if o.attributes["uid"] == "weekly-sync-1@fixture.test"]
    assert len(weekly) == 3  # FREQ=WEEKLY;COUNT=3
    assert len({o.ics_key for o in weekly}) == 3
    assert all(o.ics_key.startswith("weekly-sync-1@fixture.test:2026-") for o in weekly)
    assert [o.attributes["starts_at"] for o in weekly] == [
        "2026-07-29T12:00:00+00:00",
        "2026-08-05T12:00:00+00:00",
        "2026-08-12T12:00:00+00:00",
    ]


def test_timezone_normalized_to_utc() -> None:
    parsed = parse("base.ics")
    berlin = next(
        o for o in parsed.occurrences if o.attributes["uid"] == "berlin-call-1@fixture.test"
    )
    # 09:00 Europe/Berlin in July (CEST, UTC+2) is 07:00 UTC
    assert berlin.attributes["starts_at"] == "2026-07-31T07:00:00+00:00"
    assert berlin.attributes["ends_at"] == "2026-07-31T08:00:00+00:00"


def test_single_event_keeps_its_key_when_rescheduled() -> None:
    base = parse("base.ics")
    updated = parse("updated.ics")
    dentist_base = next(o for o in base.occurrences if o.attributes["uid"].startswith("dentist"))
    dentist_new = next(o for o in updated.occurrences if o.attributes["uid"].startswith("dentist"))
    # same identity, different content hash: an update, not a new appointment
    assert dentist_base.ics_key == dentist_new.ics_key == "dentist-1@fixture.test"
    assert dentist_base.vevent_hash != dentist_new.vevent_hash
    assert dentist_new.attributes["sequence"] == 1


def test_unchanged_events_hash_identically_across_feeds() -> None:
    base = {o.ics_key: o.vevent_hash for o in parse("base.ics").occurrences}
    updated = {o.ics_key: o.vevent_hash for o in parse("updated.ics").occurrences}
    unchanged = [k for k in base if not k.startswith("dentist")]
    assert unchanged and all(base[k] == updated[k] for k in unchanged)


def test_malformed_components_skipped_with_count() -> None:
    parsed = parse("malformed.ics")
    assert parsed.skipped == 2  # missing DTSTART + missing UID, neither crashes
    assert [o.attributes["uid"] for o in parsed.occurrences] == ["good-1@fixture.test"]


def test_attendees_parsed_and_normalized() -> None:
    parsed = parse("base.ics")
    dentist = next(o for o in parsed.occurrences if o.attributes["uid"].startswith("dentist"))
    assert [(a.email, a.name) for a in dentist.attendees] == [
        ("dana@fixture.test", "Dana Example"),
        ("rob@fixture.test", None),
    ]


def test_hostile_rrule_is_capped() -> None:
    hostile = (
        b"BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//x//EN\n"
        b"BEGIN:VEVENT\nUID:bomb@fixture.test\nDTSTART:20260701T000000Z\n"
        b"RRULE:FREQ=SECONDLY\nSUMMARY:boom\nEND:VEVENT\nEND:VCALENDAR\n"
    )
    parsed = parse_ics(hostile, WINDOW_START, WINDOW_END)
    assert parsed.truncated
    assert len(parsed.occurrences) == MAX_OCCURRENCES


def test_garbage_feed_raises_value_error() -> None:
    with pytest.raises(ValueError):
        parse_ics(b"this is not an ics feed at all", WINDOW_START, WINDOW_END)


def test_long_text_fields_truncated_to_schema_bounds() -> None:
    huge = "x" * 10_000
    feed = (
        "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//x//EN\n"
        f"BEGIN:VEVENT\nUID:long@fixture.test\nDTSTART:20260801T000000Z\n"
        f"SUMMARY:{huge}\nLOCATION:{huge}\nEND:VEVENT\nEND:VCALENDAR\n"
    ).encode()
    parsed = parse_ics(feed, WINDOW_START, WINDOW_END)
    (occ,) = parsed.occurrences
    assert len(occ.attributes["title"]) == 512
    assert len(occ.attributes["location"]) == 512
