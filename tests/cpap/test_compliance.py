"""Unit: the rolling 30-day CPAP compliance math (roadmap H2).

Pure function, no database -- table-driven boundary cases: missing nights,
partial nights, and the 30-day window boundary, matching the acceptance
criteria's explicit call-out.
"""

from datetime import date, timedelta
from uuid import UUID, uuid4

import pytest

from domains.cpap.compliance import (
    COMPLIANT_MINUTES,
    LONG_NIGHT_MINUTES,
    WINDOW_DAYS,
    ComplianceResult,
    SessionUsage,
    compute_compliance,
)

AS_OF = date(2026, 8, 30)


def usages(nights: dict[int, int]) -> list[SessionUsage]:
    """`nights` maps "days before AS_OF" -> usage_min."""
    return [
        SessionUsage(
            session_date=AS_OF - timedelta(days=offset), usage_min=minutes, entity_id=uuid4()
        )
        for offset, minutes in nights.items()
    ]


def full_month(minutes: int) -> dict[int, int]:
    return {offset: minutes for offset in range(WINDOW_DAYS)}


def test_thirty_compliant_nights_is_compliant_and_a_full_month_streak() -> None:
    result = compute_compliance(usages(full_month(300)), AS_OF)
    assert result.nights_with_data == 30
    assert result.nights_missing == 0
    assert result.nights_ge_4h == 30
    assert result.nights_ge_8h == 0
    assert result.compliant is True
    assert result.current_streak_nights == 30
    assert result.full_month_streak is True


def test_exactly_seventy_percent_is_compliant_boundary_inclusive() -> None:
    """21 of 30 nights >= 4h is exactly 70%: the DME rule reads "at least"."""
    nights = full_month(100)  # below threshold
    nights.update({offset: COMPLIANT_MINUTES for offset in range(21)})
    result = compute_compliance(usages(nights), AS_OF)
    assert result.nights_ge_4h == 21
    assert result.pct_nights_ge_4h == pytest.approx(0.7)
    assert result.compliant is True


def test_one_night_short_of_seventy_percent_is_not_compliant() -> None:
    nights = full_month(100)
    nights.update({offset: COMPLIANT_MINUTES for offset in range(20)})
    result = compute_compliance(usages(nights), AS_OF)
    assert result.nights_ge_4h == 20
    assert result.compliant is False


def test_missing_nights_count_toward_the_fixed_thirty_night_denominator() -> None:
    """25 of 30 nights have data, all compliant: the DME rule's denominator is
    the window length, not "nights we happen to have data for"."""
    nights = {offset: 300 for offset in range(25)}  # 5 nights simply absent
    result = compute_compliance(usages(nights), AS_OF)
    assert result.nights_with_data == 25
    assert result.nights_missing == 5
    assert result.nights_ge_4h == 25
    assert result.pct_nights_ge_4h == round(25 / 30, 4)  # displayed at 4 decimal places
    assert result.compliant is True  # 25/30 = 83.3% >= 70%


def test_usage_exactly_at_the_four_hour_boundary_counts() -> None:
    result = compute_compliance(usages({0: COMPLIANT_MINUTES}), AS_OF)
    assert result.nights_ge_4h == 1


def test_usage_one_minute_under_four_hours_does_not_count() -> None:
    result = compute_compliance(usages({0: COMPLIANT_MINUTES - 1}), AS_OF)
    assert result.nights_ge_4h == 0


def test_usage_exactly_at_the_eight_hour_boundary_counts() -> None:
    result = compute_compliance(usages({0: LONG_NIGHT_MINUTES}), AS_OF)
    assert result.nights_ge_8h == 1


def test_usage_one_minute_under_eight_hours_does_not_count() -> None:
    result = compute_compliance(usages({0: LONG_NIGHT_MINUTES - 1}), AS_OF)
    assert result.nights_ge_8h == 0


def test_session_thirty_one_days_before_as_of_is_excluded() -> None:
    """The window is exactly 30 consecutive days ending at as_of; a night one
    day older than that must not count."""
    result = compute_compliance(usages({WINDOW_DAYS: 300}), AS_OF)
    assert result.nights_with_data == 0


def test_session_exactly_thirty_days_before_as_of_is_included() -> None:
    result = compute_compliance(usages({WINDOW_DAYS - 1: 300}), AS_OF)
    assert result.nights_with_data == 1


def test_session_dated_after_as_of_is_excluded() -> None:
    """Defensive: a future-dated record (should not normally occur) must
    never be counted -- as_of is the right edge of the window."""
    future = SessionUsage(session_date=AS_OF + timedelta(days=1), usage_min=300, entity_id=uuid4())
    result = compute_compliance([future], AS_OF)
    assert result.nights_with_data == 0


def test_a_gap_breaks_the_streak() -> None:
    nights = full_month(300)
    del nights[2]  # a missing night two days back
    result = compute_compliance(usages(nights), AS_OF)
    assert result.current_streak_nights == 2  # today and yesterday only
    assert result.full_month_streak is False


def test_zero_usage_night_breaks_the_streak_but_counts_toward_the_window() -> None:
    """An explicit zero-usage night (mask not worn) is data, not a gap in the
    denominator, but it does not extend the usage streak."""
    nights = full_month(300)
    nights[1] = 0
    result = compute_compliance(usages(nights), AS_OF)
    assert result.nights_with_data == 30
    assert result.current_streak_nights == 1  # only "today" survives the zero night
    assert result.full_month_streak is False


def test_empty_session_list_is_all_zeros_never_compliant() -> None:
    result = compute_compliance([], AS_OF)
    assert result == ComplianceResult(
        as_of=AS_OF,
        window_start=AS_OF - timedelta(days=WINDOW_DAYS - 1),
        window_days=WINDOW_DAYS,
        nights_with_data=0,
        nights_missing=WINDOW_DAYS,
        nights_ge_4h=0,
        nights_ge_8h=0,
        pct_nights_ge_4h=0.0,
        compliant=False,
        current_streak_nights=0,
        full_month_streak=False,
        cited_entity_ids=[],
    )


def test_duplicate_session_dates_collapse_because_the_caller_dedupes_by_identity() -> None:
    """The kernel's identity resolution (session_date) guarantees at most one
    cpap_session per date; a caller handing compute_compliance two
    SessionUsage rows for the same date is a caller bug, and Python dict
    construction keeps the last one -- documented, not defended against here."""
    entity_id = uuid4()
    rows = [
        SessionUsage(session_date=AS_OF, usage_min=100, entity_id=UUID(int=1)),
        SessionUsage(session_date=AS_OF, usage_min=300, entity_id=entity_id),
    ]
    result = compute_compliance(rows, AS_OF)
    assert result.nights_with_data == 1
    assert result.nights_ge_4h == 1  # the later row (300 min) won
    assert result.cited_entity_ids == [entity_id]


def test_cited_entity_ids_are_only_the_nights_inside_the_window() -> None:
    outside = SessionUsage(
        session_date=AS_OF - timedelta(days=40), usage_min=300, entity_id=uuid4()
    )
    inside = SessionUsage(session_date=AS_OF, usage_min=300, entity_id=uuid4())
    result = compute_compliance([outside, inside], AS_OF)
    assert result.cited_entity_ids == [inside.entity_id]
