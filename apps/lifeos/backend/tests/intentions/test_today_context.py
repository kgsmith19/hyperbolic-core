"""Today command center, slice 2 (#531): the day's context around the priorities.

Integration-tested against real kernel writes. Appointments live in a year no
other fixture uses, so "exactly these appointments" assertions hold in the
shared session database; intentions carry a per-test marker for the same
reason, and balance claims are asserted as differences, never totals.
"""

from datetime import UTC, datetime, timedelta
from hashlib import sha256
from uuid import UUID, uuid4

import pytest

from domains.calendar.types import define_calendar_types
from domains.intentions.focus import capture_intention
from domains.intentions.today import UNASSIGNED, UPCOMING_LIMIT, today
from domains.intentions.types import AREAS, define_intention_types
from domains.ops.review import KNOWN_JOBS
from kernel import services
from kernel.access import AccessContext

# A Tuesday far from every other fixture's appointments.
NOW = datetime(2037, 3, 10, 9, 0, tzinfo=UTC)


@pytest.fixture(scope="module")
def seed_ctx(ctx: AccessContext) -> AccessContext:
    define_intention_types(ctx)
    define_calendar_types(ctx)
    return ctx


@pytest.fixture(autouse=True)
def utc_zone(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LIFEOS_BRIEFING_TZ", "UTC")


def appointment(ctx: AccessContext, starts_at: datetime, **extra: object) -> UUID:
    key = uuid4().hex
    attributes: dict[str, object] = {
        "ics_key": key,
        "uid": key,
        "title": f"appt-{key[:8]}",
        "starts_at": starts_at.isoformat(),
        "vevent_hash": sha256(key.encode()).hexdigest(),
        **extra,
    }
    return services.capture(ctx, "appointment", attributes).entity_id


def mine(ids: list[UUID], created: set[UUID]) -> list[UUID]:
    return [i for i in ids if i in created]


def test_balance_counts_open_items_per_area_and_shows_zeros(seed_ctx: AccessContext) -> None:
    """AC: God/Family/Work balance; an untagged item is unassigned, never guessed."""
    marker = f"bal-{uuid4().hex[:10]}"
    before = today(seed_ctx).balance
    assert set(before) == {*AREAS, UNASSIGNED}
    for title, area in (("a", "god"), ("b", "work"), ("c", "work"), ("d", None)):
        attributes: dict[str, object] = {
            "title": f"{marker}-{title}",
            "kind": "task",
            "status": "active",
            "focus": False,
        }
        if area:
            attributes["area"] = area
        capture_intention(seed_ctx, attributes)
    capture_intention(
        seed_ctx,
        {
            "title": f"{marker}-anchor",
            "kind": "habit_quota",
            "status": "active",
            "focus": False,
            "area": "family",
        },
    )
    after = today(seed_ctx).balance
    delta = {k: after[k] - before[k] for k in after}
    assert delta == {"god": 1, "family": 1, "work": 2, UNASSIGNED: 1}


def test_an_unknown_area_is_refused_by_the_schema(seed_ctx: AccessContext) -> None:
    """Negative control: the area list is closed."""
    with pytest.raises(Exception, match="area|enum|not one of"):
        capture_intention(
            seed_ctx,
            {
                "title": f"bad-area-{uuid4().hex[:8]}",
                "kind": "task",
                "status": "active",
                "focus": False,
                "area": "hobbies",
            },
        )


def test_schedule_is_todays_appointments_in_time_order(seed_ctx: AccessContext) -> None:
    """AC: today schedule. Cancelled and other-day appointments stay out."""
    late = appointment(seed_ctx, NOW.replace(hour=16))
    early = appointment(seed_ctx, NOW.replace(hour=8))
    cancelled = appointment(seed_ctx, NOW.replace(hour=12), status="CANCELLED")
    tomorrow = appointment(seed_ctx, NOW + timedelta(days=1))
    view = today(seed_ctx, now=NOW)
    created = {late, early, cancelled, tomorrow}
    assert mine([a.appointment_id for a in view.schedule], created) == [early, late]
    assert tomorrow in [a.appointment_id for a in view.upcoming]


def test_today_is_the_local_date(seed_ctx: AccessContext, monkeypatch: pytest.MonkeyPatch) -> None:
    """An evening appointment stored in UTC belongs to the local day it happens on."""
    evening_utc = datetime(2037, 3, 11, 1, 30, tzinfo=UTC)  # 21:30 on the 10th in New York
    eid = appointment(seed_ctx, evening_utc)
    monkeypatch.setenv("LIFEOS_BRIEFING_TZ", "America/New_York")
    local = today(seed_ctx, now=datetime(2037, 3, 10, 15, 0, tzinfo=UTC))
    assert eid in [a.appointment_id for a in local.schedule]
    monkeypatch.setenv("LIFEOS_BRIEFING_TZ", "UTC")
    utc = today(seed_ctx, now=datetime(2037, 3, 10, 15, 0, tzinfo=UTC))
    assert eid not in [a.appointment_id for a in utc.schedule]


def test_upcoming_is_bounded_and_counts_the_rest(seed_ctx: AccessContext) -> None:
    """AC: upcoming commitments, without clutter: at most UPCOMING_LIMIT shown."""
    base = datetime(2037, 6, 2, 9, 0, tzinfo=UTC)
    created = [appointment(seed_ctx, base + timedelta(days=1, hours=n)) for n in range(7)]
    beyond = appointment(seed_ctx, base + timedelta(days=9))
    view = today(seed_ctx, now=base)
    shown = [a.appointment_id for a in view.upcoming]
    assert shown == created[:UPCOMING_LIMIT]
    assert view.more_upcoming == 7 - UPCOMING_LIMIT
    assert beyond not in shown


def test_sources_report_every_scheduled_job(seed_ctx: AccessContext) -> None:
    """AC: source freshness and sync status -- a job that never ran is reported missed."""
    view = today(seed_ctx, now=NOW)
    assert [s.job for s in view.sources] == list(KNOWN_JOBS)
    assert all(s.missed for s in view.sources)  # nothing ran on NOW's date
    assert view.unavailable == []


def test_a_missing_scope_is_reported_not_raised() -> None:
    """A narrow token sees its intentions and is told which sections it cannot read."""
    narrow = AccessContext.of("intentions:read")
    view = today(narrow, now=NOW)
    assert view.unavailable == ["calendar", "sources"]
    assert view.schedule == [] and view.upcoming == [] and view.sources == []
