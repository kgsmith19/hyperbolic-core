"""Weekly review / briefing surface (LO-3, m5-07).

`_job_health` and range filtering are exercised through the public
`review_feed` (integration tier, real Postgres) -- there is no separately
meaningful pure-unit layer here the way `freshness.classify` has one:
every interesting behavior (range inclusion, job-health "missed") needs
real dated entities to be checkable at all.

Integration fixtures are dated in 2035: unclaimed by every other ops
fixture era (adherence 2029, briefing 2031/2032/2034, freshness 2033;
see test_adherence.py's own header comment for that registry), so
nothing seeded here can land inside another module's window or become
another module's "newest" reading in the shared test database, and
nothing another module seeds can appear as "in range" or "today" here.
"""

from datetime import UTC, date, datetime, timedelta

import pytest

from domains.calendar.autolink import METHOD as CALENDAR_AUTOLINK_JOB
from domains.calendar.ingest import METHOD as CALENDAR_INGEST_JOB
from domains.calendar.types import define_calendar_types
from domains.ops.briefing import METHOD as BRIEFING_JOB
from domains.ops.receipts import STATUS_FAILED, STATUS_OK
from domains.ops.review import KNOWN_JOBS, review_context, review_feed
from domains.ops.types import define_ops_types
from kernel.access import AccessContext, ScopeError
from kernel.services import capture

YEAR = 2035
BASE = datetime(YEAR, 3, 1, tzinfo=UTC)


@pytest.fixture(scope="module")
def fresh_ctx(ctx: AccessContext) -> AccessContext:
    """The exact production context (read-only): used to exercise
    `review_feed` itself, never to seed fixture data."""
    define_ops_types(ctx)
    define_calendar_types(ctx)
    return review_context()


@pytest.fixture(scope="module")
def seed_ctx() -> AccessContext:
    """Write scopes for arranging fixture data only -- `review_feed` itself
    is always exercised through the read-only `fresh_ctx` above, so this
    fixture never touches the query under test."""
    return AccessContext.of("ops:read", "ops:write")


def make_briefing(ctx: AccessContext, day: date, marker: str) -> None:
    capture(
        ctx,
        "briefing",
        {
            "briefing_key": f"{day.isoformat()}-{marker}",
            "date": day.isoformat(),
            "focus_intention_ids": [],
            "appointment_ids": [],
            "provenance": {
                "source_entity_ids": [],
                "source_event_ids": [],
                "method": "test_review_feed",
                "confidence": 1.0,
            },
        },
        actor="test_review_feed",
    )


def at_hour(day: date, hour: int) -> datetime:
    return datetime.combine(day, datetime.min.time(), tzinfo=UTC) + timedelta(hours=hour)


def make_receipt(
    ctx: AccessContext, job: str, started_at: datetime, status: str = STATUS_OK
) -> None:
    capture(
        ctx,
        "execution_receipt",
        {
            "job": job,
            "started_at": started_at.isoformat(),
            "finished_at": started_at.isoformat(),
            "status": status,
            "summary": "test_review_feed fixture",
        },
        actor=job,
    )


def by_job(feed) -> dict:
    return {h.job: h for h in feed.job_health}


# ---------------------------------------------------------------------------
# LO-3a: date-range aggregation.
# ---------------------------------------------------------------------------


def test_briefings_and_receipts_in_range_are_returned(
    fresh_ctx: AccessContext, seed_ctx: AccessContext
) -> None:
    day = (BASE + timedelta(days=1)).date()
    make_briefing(seed_ctx, day, "in-range")
    make_receipt(seed_ctx, CALENDAR_INGEST_JOB, BASE + timedelta(days=1, hours=2))

    feed = review_feed(fresh_ctx, day, day, now=BASE + timedelta(days=1, hours=3))

    assert any(b.date == day.isoformat() for b in feed.briefings)
    assert any(r.job == CALENDAR_INGEST_JOB for r in feed.receipts)


def test_a_briefing_or_receipt_outside_the_range_is_excluded(
    fresh_ctx: AccessContext, seed_ctx: AccessContext
) -> None:
    in_range_day = (BASE + timedelta(days=5)).date()
    out_of_range_day = (BASE + timedelta(days=50)).date()
    make_briefing(seed_ctx, out_of_range_day, "out-of-range")
    make_receipt(seed_ctx, CALENDAR_INGEST_JOB, BASE + timedelta(days=50, hours=1))

    feed = review_feed(fresh_ctx, in_range_day, in_range_day, now=BASE + timedelta(days=5, hours=1))

    assert not any(b.date == out_of_range_day.isoformat() for b in feed.briefings)
    assert not any(
        r.started_at.startswith(out_of_range_day.isoformat()) for r in feed.receipts
    )


def test_range_boundaries_are_inclusive(fresh_ctx: AccessContext, seed_ctx: AccessContext) -> None:
    start_day = (BASE + timedelta(days=10)).date()
    end_day = (BASE + timedelta(days=12)).date()
    make_briefing(seed_ctx, start_day, "start-boundary")
    make_briefing(seed_ctx, end_day, "end-boundary")

    feed = review_feed(fresh_ctx, start_day, end_day, now=BASE + timedelta(days=12, hours=1))

    dates = {b.date for b in feed.briefings}
    assert start_day.isoformat() in dates
    assert end_day.isoformat() in dates


def test_end_before_start_is_refused() -> None:
    with pytest.raises(ValueError, match="end must not be before start"):
        review_feed(AccessContext.all(), date(YEAR, 6, 2), date(YEAR, 6, 1))


# ---------------------------------------------------------------------------
# LO-3b: missed-receipt job health.
# ---------------------------------------------------------------------------


def test_a_job_with_a_receipt_today_is_not_flagged_missed(
    fresh_ctx: AccessContext, seed_ctx: AccessContext
) -> None:
    today = (BASE + timedelta(days=20)).date()
    make_receipt(seed_ctx, BRIEFING_JOB, at_hour(today, 6))

    feed = review_feed(fresh_ctx, today, today, now=at_hour(today, 12))

    assert by_job(feed)[BRIEFING_JOB].missed is False
    assert by_job(feed)[BRIEFING_JOB].last_status == STATUS_OK


def test_a_job_with_no_receipt_today_is_flagged_missed(fresh_ctx: AccessContext) -> None:
    # A whole fresh day with no seeding at all for any job -- the gap case
    # the acceptance criteria (LO-3b) names explicitly ("seed a gap, assert
    # the missed flag").
    today = (BASE + timedelta(days=25)).date()

    feed = review_feed(fresh_ctx, today, today, now=at_hour(today, 12))

    for job in KNOWN_JOBS:
        assert by_job(feed)[job].missed is True


def test_a_failed_attempt_today_still_proves_the_scheduler_fired_not_missed(
    fresh_ctx: AccessContext, seed_ctx: AccessContext
) -> None:
    today = (BASE + timedelta(days=30)).date()
    started_at = at_hour(today, 6)
    make_receipt(seed_ctx, CALENDAR_AUTOLINK_JOB, started_at, status=STATUS_FAILED)

    feed = review_feed(fresh_ctx, today, today, now=started_at + timedelta(hours=1))

    health = by_job(feed)[CALENDAR_AUTOLINK_JOB]
    assert health.missed is False, "the scheduler ran it -- a failed run is not a missed one"
    assert health.last_status == STATUS_FAILED


def test_job_health_is_independent_of_the_requested_range(
    fresh_ctx: AccessContext, seed_ctx: AccessContext
) -> None:
    today = (BASE + timedelta(days=35)).date()
    make_receipt(seed_ctx, BRIEFING_JOB, at_hour(today, 6))
    long_ago = today - timedelta(days=400)

    # A range far in the past still reports TODAY's job health, not a
    # historical one -- job_health is a live status panel (this module's
    # own doc comment), never scoped to the requested window.
    feed = review_feed(fresh_ctx, long_ago, long_ago, now=at_hour(today, 12))

    assert by_job(feed)[BRIEFING_JOB].missed is False


def test_known_jobs_cover_every_daily_scheduled_entry_point() -> None:
    assert set(KNOWN_JOBS) == {BRIEFING_JOB, CALENDAR_INGEST_JOB, CALENDAR_AUTOLINK_JOB}


# ---------------------------------------------------------------------------
# Scope discipline.
# ---------------------------------------------------------------------------


def test_review_context_is_read_only() -> None:
    assert review_context().scopes == {"ops:read"}


def test_review_feed_refuses_without_read_scope() -> None:
    with pytest.raises(ScopeError):
        review_feed(AccessContext.of("intentions:read"), date(YEAR, 1, 1), date(YEAR, 1, 1))
