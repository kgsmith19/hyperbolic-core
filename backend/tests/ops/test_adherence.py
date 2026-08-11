"""Adherence rollup pack tests (Issue #87, roadmap D1).

`classify_band` / `weight_trend` / `score_quota` / `capture_gaps` are pure and
unit-tested directly with no ctx and no database. The `*_rollup` services read
real kernel entities and are integration-tested against Postgres — the same
split `domains.ops.freshness` uses between `classify` and `compute_ledger`.

Integration fixtures are dated in 2029: earlier than every other ops fixture
era (briefing 2031/2032/2034, freshness 2033), so nothing seeded here can
become another module's "newest" reading or land inside another module's
gate/compliance window in the shared test database.
"""

from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest

from domains.health_connect.types import (
    content_hash_exercise,
    content_hash_weight,
    define_health_connect_types,
)
from domains.intentions.types import define_intention_types
from domains.ops.adherence import (
    BAND_GAINING,
    BAND_GREEN,
    BAND_INSUFFICIENT,
    BAND_MAINTAINING,
    BAND_RAPID,
    LAPSE_THRESHOLD_DAYS,
    METHOD,
    STATUS_FROZEN,
    STATUS_MET,
    STATUS_MISSED,
    STATUS_REPAIRED,
    CaptureGap,
    QuotaSpec,
    adherence_context,
    capture_gaps,
    classify_band,
    lapse_summary_rollup,
    quota_rollup,
    score_quota,
    weight_trend,
    weight_trend_rollup,
)
from kernel.access import AccessContext, ScopeError
from kernel.services import capture
from scripts.define_daily_checkin import define_daily_checkin

# ---------------------------------------------------------------------------
# Unit: classify_band is pure. pct_per_week is signed: negative is loss.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("pct_per_week", "band"),
    [
        (0.3, BAND_GAINING),  # any gain at all reads as gaining
        (0.0, BAND_MAINTAINING),  # flat is maintaining, never "gaining"
        (-0.49, BAND_MAINTAINING),  # just under the green floor
        (-0.5, BAND_GREEN),  # green floor is inclusive
        (-0.75, BAND_GREEN),
        (-1.0, BAND_GREEN),  # green ceiling is inclusive
        (-1.01, BAND_RAPID),  # past the ceiling
    ],
)
def test_band_boundaries(pct_per_week: float, band: str) -> None:
    assert classify_band(pct_per_week) == band


# ---------------------------------------------------------------------------
# Unit: weight_trend is pure — sparse data must degrade, never fabricate.
# ---------------------------------------------------------------------------

T0 = datetime(2029, 1, 1, 8, 0, tzinfo=UTC)


def at(days: float) -> datetime:
    return T0 + timedelta(days=days)


def test_no_readings_is_insufficient() -> None:
    trend = weight_trend([])
    assert trend.band == BAND_INSUFFICIENT
    assert trend.pct_per_week is None and trend.ewma_kg is None
    assert trend.readings == 0


def test_single_reading_is_insufficient_but_reports_the_reading() -> None:
    trend = weight_trend([(T0, 90.0)])
    assert trend.band == BAND_INSUFFICIENT
    assert trend.ewma_kg == 90.0
    assert trend.pct_per_week is None


def test_span_under_a_week_is_insufficient() -> None:
    trend = weight_trend([(at(0), 90.0), (at(6.9), 89.0)])
    assert trend.band == BAND_INSUFFICIENT


def test_two_point_rate_is_exact() -> None:
    # e0 = 100; gap 7 days so w = 1 - 0.9**7 = 0.5217031; e7 = 100 - w*1.
    # pct/week = (e7 - e0) / e7 * 100 = -0.5244…, inside the green band.
    trend = weight_trend([(at(0), 100.0), (at(7), 99.0)])
    assert trend.pct_per_week == pytest.approx(-0.5244, abs=1e-3)
    assert trend.band == BAND_GREEN
    assert trend.readings == 2
    assert trend.window_days == pytest.approx(7.0)


def test_constant_weight_is_maintaining() -> None:
    trend = weight_trend([(at(float(d)), 82.0) for d in range(0, 28, 2)])
    assert trend.pct_per_week == 0.0
    assert trend.band == BAND_MAINTAINING
    assert trend.ewma_kg == 82.0


def test_sparse_readings_with_missing_weeks_still_compute() -> None:
    # Three readings across five weeks — whole missing weeks in between are
    # a normal input, not an error.
    trend = weight_trend([(at(0), 100.0), (at(14), 100.0), (at(35), 100.0)])
    assert trend.band == BAND_MAINTAINING
    assert trend.readings == 3


def test_rapid_loss_reads_rapid() -> None:
    # 0.3 kg/day off 100 kg is ~2%/week — well past the green ceiling.
    trend = weight_trend([(at(float(d)), 100.0 - 0.3 * d) for d in range(0, 30)])
    assert trend.band == BAND_RAPID


def test_the_anchor_is_named() -> None:
    trend = weight_trend([(at(0), 100.0), (at(7), 99.0)])
    assert "EWMA" in trend.anchor and "week" in trend.anchor


# ---------------------------------------------------------------------------
# Unit: score_quota — deterministic freeze and repair-window rules.
# ---------------------------------------------------------------------------

MONDAY = date(2029, 1, 1)  # 2029-01-01 is a Monday


def on(day_offset: int, hour: int = 12) -> datetime:
    return datetime(2029, 1, 1, hour, tzinfo=UTC) + timedelta(days=day_offset)


def statuses(scores: list[Any]) -> list[str]:
    return [s.status for s in scores]


def test_rejects_bad_inputs() -> None:
    with pytest.raises(ValueError):
        score_quota(0, [], MONDAY, 1)
    with pytest.raises(ValueError):
        score_quota(3, [], date(2029, 1, 2), 1)  # not a Monday
    with pytest.raises(ValueError):
        score_quota(3, [], MONDAY, 0)
    with pytest.raises(ValueError):
        score_quota(3, [], MONDAY, 1, freeze_allowance=0)
    with pytest.raises(ValueError):
        score_quota(3, [], MONDAY, 1, freeze_allowance=3)


def test_met_week() -> None:
    scores = score_quota(3, [on(0), on(2), on(4)], MONDAY, 1)
    assert statuses(scores) == [STATUS_MET]
    assert scores[0].count == 3 and scores[0].repairs == 0


def test_repair_window_completes_a_short_week() -> None:
    # Two in-week completions plus one on the following Monday at 10:00 —
    # inside the 24h repair window. It repairs week 1 and is therefore NOT
    # counted again in week 2.
    completions = [on(0), on(2), on(7, hour=10), on(8), on(9), on(11)]
    scores = score_quota(3, completions, MONDAY, 2)
    assert statuses(scores) == [STATUS_REPAIRED, STATUS_MET]
    assert scores[0].count == 2 and scores[0].repairs == 1
    assert scores[1].count == 3  # the repair completion was consumed


def test_repair_window_boundary_is_exactly_24h() -> None:
    # Exactly at week end (Monday 00:00) is inside the window; exactly 24h
    # after week end (Tuesday 00:00) is outside it.
    inside = score_quota(1, [on(7, hour=0)], MONDAY, 1)
    assert statuses(inside) == [STATUS_REPAIRED]
    outside = score_quota(1, [on(8, hour=0)], MONDAY, 1)
    assert statuses(outside) == [STATUS_FROZEN]  # no repair, freeze absorbs it


def test_partial_repair_does_not_consume_the_completion() -> None:
    # Week 1 is short by two; only one repair candidate exists. It cannot
    # complete the week, so it stays in week 2 where it was actually done.
    completions = [on(0), on(7, hour=10)]
    scores = score_quota(3, completions, MONDAY, 2, freeze_allowance=1)
    assert statuses(scores)[0] == STATUS_FROZEN
    assert scores[0].repairs == 0
    assert scores[1].count == 1


def test_freezes_are_limited_per_rolling_window() -> None:
    # Five empty weeks, allowance 1: the first miss freezes, the next three
    # are within the rolling 4-week window and score missed, and by week 5
    # the frozen week has left the window so a freeze is available again.
    scores = score_quota(1, [], MONDAY, 5)
    assert statuses(scores) == [
        STATUS_FROZEN,
        STATUS_MISSED,
        STATUS_MISSED,
        STATUS_MISSED,
        STATUS_FROZEN,
    ]


def test_allowance_of_two_freezes_two_weeks() -> None:
    scores = score_quota(1, [], MONDAY, 3, freeze_allowance=2)
    assert statuses(scores) == [STATUS_FROZEN, STATUS_FROZEN, STATUS_MISSED]


def test_freeze_immediately_followed_by_a_repaired_week() -> None:
    # Week 1 empty (frozen); week 2 short but repaired from the 24h window.
    completions = [on(8), on(14, hour=9)]
    scores = score_quota(2, completions, MONDAY, 2)
    assert statuses(scores) == [STATUS_FROZEN, STATUS_REPAIRED]


# ---------------------------------------------------------------------------
# Unit: capture_gaps — measured gaps only, boundary at exactly the threshold.
# ---------------------------------------------------------------------------


def test_gap_threshold_boundary() -> None:
    base = date(2029, 3, 1)
    six_missing = [base, base + timedelta(days=7)]
    assert capture_gaps(six_missing) == []
    seven_missing = [base, base + timedelta(days=8)]
    assert capture_gaps(seven_missing) == [
        CaptureGap(last_seen=base, resumed=base + timedelta(days=8), gap_days=7)
    ]
    assert LAPSE_THRESHOLD_DAYS == 7


def test_multiple_gaps_in_order_from_unsorted_input_with_duplicates() -> None:
    base = date(2029, 3, 1)
    days = [
        base + timedelta(days=40),
        base,
        base + timedelta(days=10),
        base,  # duplicate
        base + timedelta(days=11),
    ]
    gaps = capture_gaps(days)
    assert [(g.last_seen, g.resumed, g.gap_days) for g in gaps] == [
        (base, base + timedelta(days=10), 9),
        (base + timedelta(days=11), base + timedelta(days=40), 28),
    ]


def test_fewer_than_two_days_has_no_gaps() -> None:
    assert capture_gaps([]) == []
    assert capture_gaps([date(2029, 3, 1)]) == []


# ---------------------------------------------------------------------------
# Integration: the rollups read real kernel entities.
# ---------------------------------------------------------------------------

WEIGHT_AT = datetime(2029, 6, 1, 7, 0, tzinfo=UTC)
QUOTA_WEEK = date(2029, 6, 4)  # a Monday
GAP_START = date(2029, 5, 1)


@pytest.fixture(scope="module")
def read_ctx(ctx: AccessContext) -> AccessContext:
    """The exact production context (read-only), after seeding fixture data
    with a separate write-scoped context."""
    define_health_connect_types(ctx)
    define_intention_types(ctx)
    define_daily_checkin(ctx)
    seed = AccessContext.of(
        "health_connect:read",
        "health_connect:write",
        "wellbeing:read",
        "wellbeing:write",
        "intentions:read",
        "intentions:write",
    )
    for day in range(0, 22, 7):  # four weekly readings losing 1 kg/week
        when = WEIGHT_AT + timedelta(days=day)
        kilograms = 100.0 - day / 7
        capture(
            seed,
            "weight_measurement",
            {
                "content_hash": content_hash_weight(kilograms, when.isoformat()),
                "kilograms": kilograms,
                "time": when.isoformat(),
                "source": "test",
            },
        )
    capture(
        seed,
        "intention",
        {
            "title": "d1 lifting",
            "kind": "habit_quota",
            "status": "active",
            "focus": False,
        },
    )
    for day in (0, 2):
        start = datetime.combine(QUOTA_WEEK, datetime.min.time(), UTC) + timedelta(
            days=day, hours=18
        )
        capture(
            seed,
            "activity_summary",
            {
                "content_hash": content_hash_exercise("d1 lifting", start.isoformat(), 3600),
                "exercise_type": "d1 lifting",
                "start_time": start.isoformat(),
                "duration_seconds": 3600,
                "source": "test",
            },
        )
    checkin_days = [GAP_START, GAP_START + timedelta(days=1), GAP_START + timedelta(days=10)]
    checkin_days += [QUOTA_WEEK + timedelta(days=d) for d in (0, 4)]
    for day in checkin_days:
        capture(
            seed,
            "daily_checkin",
            {
                "date": day.isoformat(),
                "mood": 3,
                "energy": 3,
                "stress": 3,
                "sleep_quality": 3,
                "practices_completed": ["d1 meditation"],
            },
        )
    return adherence_context()


def test_context_is_read_only() -> None:
    assert adherence_context().scopes == {
        "wellbeing:read",
        "health_connect:read",
        "intentions:read",
    }


def test_weight_trend_rollup_cites_the_readings(read_ctx: AccessContext) -> None:
    rollup = weight_trend_rollup(read_ctx)
    assert rollup["band"] == BAND_GREEN
    assert rollup["readings"] >= 3
    provenance = rollup["provenance"]
    assert provenance["method"] == METHOD and provenance["confidence"] == 1.0
    assert len(provenance["source_entity_ids"]) >= 3
    assert len(provenance["source_event_ids"]) >= 3


def test_quota_rollup_scores_exercise_and_practice_quotas(read_ctx: AccessContext) -> None:
    rollup = quota_rollup(
        read_ctx,
        [QuotaSpec("d1 lifting", 2), QuotaSpec("d1 meditation", 3)],
        QUOTA_WEEK,
        1,
    )
    lifting, meditation = rollup["quotas"]
    assert lifting["title"] == "d1 lifting"
    assert lifting["weeks"] == [
        {"week_start": QUOTA_WEEK.isoformat(), "count": 2, "repairs": 0, "status": STATUS_MET}
    ]
    # Two check-ins listing the practice against a target of 3: short, no
    # repair candidate, freeze absorbs the miss.
    assert meditation["weeks"][0]["count"] == 2
    assert meditation["weeks"][0]["status"] == STATUS_FROZEN
    assert rollup["provenance"]["method"] == METHOD
    assert rollup["provenance"]["source_entity_ids"]


def test_lapse_summary_reports_only_measured_facts(read_ctx: AccessContext) -> None:
    rollup = lapse_summary_rollup(read_ctx)
    gap_starts = {g["last_seen"] for g in rollup["gaps"]}
    assert (GAP_START + timedelta(days=1)).isoformat() in gap_starts
    gap = next(
        g for g in rollup["gaps"] if g["last_seen"] == (GAP_START + timedelta(days=1)).isoformat()
    )
    assert gap["resumed"] == (GAP_START + timedelta(days=10)).isoformat()
    assert gap["gap_days"] == 8
    # In-gap arrivals are counted, not narrated: the 2029-06 fixtures are
    # outside this gap, so both counts are zero here.
    assert gap["weights_recorded"] == 0 and gap["activities_recorded"] == 0
    # The next gap (2029-05-11 -> 2029-06-04) contains exactly one weight
    # reading (2029-06-01) and no activity: arrivals during a lapse are
    # counted from their own timestamps, with the resume-day boundary
    # exclusive (the 06-04 session belongs to the resumed period).
    second = next(
        g for g in rollup["gaps"] if g["last_seen"] == (GAP_START + timedelta(days=10)).isoformat()
    )
    assert second["gap_days"] == 23
    assert second["weights_recorded"] == 1 and second["activities_recorded"] == 0
    # The no-fabrication contract: a gap carries ONLY measured facts — dates,
    # length, in-gap arrival counts. No reason, cause, or narrative field of
    # any kind may appear unless it was verified input (none exists).
    for entry in rollup["gaps"]:
        assert set(entry) == {
            "last_seen",
            "resumed",
            "gap_days",
            "weights_recorded",
            "activities_recorded",
        }
    assert rollup["provenance"]["method"] == METHOD


def test_rollups_refuse_without_read_scope(read_ctx: AccessContext) -> None:
    with pytest.raises(ScopeError):
        weight_trend_rollup(AccessContext.of("ops:read"))
    with pytest.raises(ScopeError):
        lapse_summary_rollup(AccessContext.of("ops:read"))
