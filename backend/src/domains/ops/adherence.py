"""Adherence rollup pack (Issue #87, roadmap D1). Read-only, advisory.

Three deterministic read services over data other cells already ingest —
weight_measurement / activity_summary (H1), daily_checkin (A2.5/INT1) and
habit_quota intentions (INT1). Code computes, the model narrates (ADR 019):
no LLM is involved anywhere here, nothing is persisted, and no outward action
of any kind exists in this module. The same query-not-type posture as the
source-freshness ledger (`domains.ops.freshness`, issue #90).

1. Weight trend: a gap-aware EWMA over verified scale readings, reported as
   a signed percent-of-current-EWMA-weight per week against explicit bands
   (green = 0.5-1.0%/week of loss, both bounds inclusive). The anchor is
   named on every result (ADR 019 "every formula names its anchor"); too
   little data reads `insufficient_data`, never a fabricated band.
2. Weekly quota scoring: completions counted per Mon-Sun week against an
   operator-supplied target (the C0.5 `months_of_cover` precedent for
   operator-supplied numbers: no persisted config type until one is needed),
   with two deterministic mercy rules and no daily streaks anywhere:
   a 24h repair window (a completion within 24h after week end completes a
   just-short week, and is then not counted in its own week) and a freeze
   allowance (1-2 excused misses per rolling 4 scored weeks).
3. Lapse/resume: every gap of >= 7 days between daily check-ins, reported as
   measured facts only — boundary dates, missing-day count, and how many
   weight/activity records arrived during the gap. No cause, reason or
   narrative field exists in the output: nothing here may moralize or invent
   an explanation that was never verified input.

Every rollup carries the ADR 010 provenance envelope citing the entities and
events it was computed from, confidence 1.0 (deterministic arithmetic over
verified records). Outputs are counts, dates, statuses and ids — never
practice text, never a raw attribute another module did not already surface.

The `elimination_window` registry rider is deliberately NOT defined in this
slice: the issue adds it "only as required by its comparison-rollup consumer",
and no comparison rollup exists yet (D2 territory) — defining the type now
would be unused scaffolding.
"""

from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, time, timedelta
from itertools import pairwise
from typing import Any
from uuid import UUID

from domains.ops.common import optional_find, parse_when
from kernel import services
from kernel.access import AccessContext
from kernel.models import Entity

METHOD = "domains.ops.adherence"

# --- weight trend -----------------------------------------------------------

# Per-day smoothing for the trend weight (the classic trend-line constant).
# Readings arrive on irregular days, so the weight applied to a reading is
# gap-aware: w = 1 - (1 - alpha) ** gap_days, which equals alpha for daily
# readings and approaches 1 (a reset) after a long silence.
EWMA_ALPHA_PER_DAY = 0.1
TREND_WINDOW_DAYS = 7

BAND_GAINING = "gaining"
BAND_MAINTAINING = "maintaining"
BAND_GREEN = "green"
BAND_RAPID = "rapid"
BAND_INSUFFICIENT = "insufficient_data"

# Loss bands as percent of current EWMA weight per week; both green bounds
# inclusive, so exactly 0.5 and exactly 1.0 both read green.
GREEN_LOSS_MIN_PCT = 0.5
GREEN_LOSS_MAX_PCT = 1.0

ANCHOR = (
    "signed percent of current EWMA trend weight per week "
    f"(EWMA alpha {EWMA_ALPHA_PER_DAY}/day, gap-aware; negative is loss)"
)


@dataclass(frozen=True)
class WeightTrend:
    band: str
    ewma_kg: float | None
    pct_per_week: float | None  # signed: negative is loss
    window_days: float | None  # actual span the rate was measured over
    readings: int
    anchor: str = ANCHOR


def classify_band(pct_per_week: float) -> str:
    """The explicit band a signed %/week rate falls in. Pure function."""
    if pct_per_week > 0:
        return BAND_GAINING
    loss = -pct_per_week
    if loss < GREEN_LOSS_MIN_PCT:
        return BAND_MAINTAINING
    if loss <= GREEN_LOSS_MAX_PCT:
        return BAND_GREEN
    return BAND_RAPID


def ewma_series(readings: list[tuple[datetime, float]]) -> list[tuple[datetime, float]]:
    """Gap-aware EWMA at each reading, in time order. Pure function."""
    series: list[tuple[datetime, float]] = []
    ewma = 0.0
    previous: datetime | None = None
    for when, kilograms in sorted(readings):
        if previous is None:
            ewma = kilograms
        else:
            gap_days = (when - previous).total_seconds() / 86400
            weight = 1 - (1 - EWMA_ALPHA_PER_DAY) ** gap_days
            ewma = weight * kilograms + (1 - weight) * ewma
        previous = when
        series.append((when, ewma))
    return series


def weight_trend(readings: list[tuple[datetime, float]]) -> WeightTrend:
    """EWMA trend over verified readings. Pure function.

    The rate compares the current EWMA against the EWMA at the last reading
    at least TREND_WINDOW_DAYS earlier, normalized to a per-week percent of
    the CURRENT EWMA (the named anchor). Fewer than two readings, or a span
    shorter than the window, is `insufficient_data` — sparse data degrades
    honestly instead of extrapolating.
    """
    series = ewma_series(readings)
    if not series:
        return WeightTrend(BAND_INSUFFICIENT, None, None, None, 0)
    latest_at, latest_ewma = series[-1]
    cutoff = latest_at - timedelta(days=TREND_WINDOW_DAYS)
    reference = next(((at, e) for at, e in reversed(series) if at <= cutoff), None)
    if reference is None or latest_ewma <= 0:
        return WeightTrend(BAND_INSUFFICIENT, latest_ewma, None, None, len(series))
    reference_at, reference_ewma = reference
    span_days = (latest_at - reference_at).total_seconds() / 86400
    pct_per_week = (
        (latest_ewma - reference_ewma) / latest_ewma * 100 * (TREND_WINDOW_DAYS / span_days)
    )
    return WeightTrend(
        classify_band(pct_per_week), latest_ewma, pct_per_week, span_days, len(series)
    )


# --- weekly quota scoring ---------------------------------------------------

REPAIR_WINDOW = timedelta(hours=24)
MAX_FREEZE_ALLOWANCE = 2
FREEZE_WINDOW_WEEKS = 4

STATUS_MET = "met"
STATUS_REPAIRED = "repaired"
STATUS_FROZEN = "frozen"
STATUS_MISSED = "missed"


@dataclass(frozen=True)
class WeekScore:
    week_start: date  # always a Monday
    count: int  # completions inside the week itself
    repairs: int  # completions credited from the 24h repair window
    status: str


@dataclass(frozen=True)
class QuotaSpec:
    """One quota to score: completions match `title` exactly (casefolded)
    against check-in practice entries and activity exercise types."""

    title: str
    target_per_week: int
    freeze_allowance: int = 1


def score_quota(
    target_per_week: int,
    completions: list[datetime],
    first_week: date,
    weeks: int,
    freeze_allowance: int = 1,
) -> list[WeekScore]:
    """Deterministic weekly scores. Pure function; completions are aware
    datetimes. Rules, in order, per Mon-Sun week:

    - count >= target: `met`.
    - Short weeks look at the 24h repair window [week end, week end + 24h).
      Repairs apply only when they COMPLETE the week; a consumed repair is
      excluded from the week it was actually performed in (counted once,
      ever). A partial repair is not consumed — the completion stays in its
      own week. Repaired weeks score `repaired`.
    - A still-short week is `frozen` when fewer than `freeze_allowance`
      weeks among the previous FREEZE_WINDOW_WEEKS - 1 scored weeks are
      frozen, else `missed`. No daily streaks exist anywhere in this model.
    """
    if target_per_week < 1:
        raise ValueError("target_per_week must be >= 1")
    if first_week.isoweekday() != 1:
        raise ValueError("first_week must be a Monday")
    if weeks < 1:
        raise ValueError("weeks must be >= 1")
    if not 1 <= freeze_allowance <= MAX_FREEZE_ALLOWANCE:
        raise ValueError(f"freeze_allowance must be 1-{MAX_FREEZE_ALLOWANCE}")

    ordered = sorted(completions)
    consumed: set[int] = set()
    scores: list[WeekScore] = []
    for index in range(weeks):
        week_start = first_week + timedelta(weeks=index)
        start = datetime.combine(week_start, time.min, UTC)
        end = start + timedelta(days=7)
        count = sum(
            1 for i, c in enumerate(ordered) if i not in consumed and start <= c < end
        )
        repairs = 0
        if count >= target_per_week:
            status = STATUS_MET
        else:
            candidates = [
                i
                for i, c in enumerate(ordered)
                if i not in consumed and end <= c < end + REPAIR_WINDOW
            ]
            shortfall = target_per_week - count
            if len(candidates) >= shortfall:
                consumed.update(candidates[:shortfall])
                repairs = shortfall
                status = STATUS_REPAIRED
            else:
                recent = scores[-(FREEZE_WINDOW_WEEKS - 1) :]
                frozen_recently = sum(1 for s in recent if s.status == STATUS_FROZEN)
                status = STATUS_FROZEN if frozen_recently < freeze_allowance else STATUS_MISSED
        scores.append(WeekScore(week_start, count, repairs, status))
    return scores


# --- lapse / resume ---------------------------------------------------------

LAPSE_THRESHOLD_DAYS = 7


@dataclass(frozen=True)
class CaptureGap:
    last_seen: date
    resumed: date
    gap_days: int  # whole days with no capture between the two


def capture_gaps(days: list[date]) -> list[CaptureGap]:
    """Every >= LAPSE_THRESHOLD_DAYS gap between capture days, in order.
    Pure function; duplicates and ordering in the input are irrelevant."""
    gaps: list[CaptureGap] = []
    for previous, current in pairwise(sorted(set(days))):
        missing = (current - previous).days - 1
        if missing >= LAPSE_THRESHOLD_DAYS:
            gaps.append(CaptureGap(previous, current, missing))
    return gaps


# --- kernel-backed rollups --------------------------------------------------


def adherence_context() -> AccessContext:
    """Exactly the read scopes the rollups need — no write scope on anything,
    and nothing here writes at all."""
    return AccessContext.of("wellbeing:read", "health_connect:read", "intentions:read")


def _provenance(ctx: AccessContext, cited: list[UUID]) -> dict[str, Any]:
    cited = list(dict.fromkeys(cited))  # an entity is cited once, in first-seen order
    return {
        "source_entity_ids": [str(i) for i in cited],
        "source_event_ids": services.latest_event_ids(ctx, cited),
        "method": METHOD,
        "confidence": 1.0,
    }


def _weight_readings(ctx: AccessContext) -> list[tuple[datetime, float, UUID]]:
    readings = []
    for entity in optional_find(ctx, "weight_measurement"):
        when = parse_when(entity.attributes.get("time"))
        kilograms = entity.attributes.get("kilograms")
        if when is not None and isinstance(kilograms, int | float):
            readings.append((when, float(kilograms), entity.id))
    return readings


def _activities(ctx: AccessContext) -> list[tuple[datetime, str, UUID]]:
    sessions = []
    for entity in optional_find(ctx, "activity_summary"):
        when = parse_when(entity.attributes.get("start_time"))
        kind = entity.attributes.get("exercise_type")
        if when is not None and isinstance(kind, str):
            sessions.append((when, kind, entity.id))
    return sessions


def _checkin_days(ctx: AccessContext) -> list[tuple[date, Entity]]:
    days = []
    for entity in optional_find(ctx, "daily_checkin"):
        raw = entity.attributes.get("date")
        if not isinstance(raw, str):
            continue
        try:
            days.append((date.fromisoformat(raw), entity))
        except ValueError:
            continue
    return days


def weight_trend_rollup(ctx: AccessContext) -> dict[str, Any]:
    """The EWMA weight trend over every verified weight event, with the
    provenance envelope citing the readings it saw."""
    readings = _weight_readings(ctx)
    trend = weight_trend([(when, kilograms) for when, kilograms, _ in readings])
    return {**asdict(trend), "provenance": _provenance(ctx, [rid for _, _, rid in readings])}


def quota_rollup(
    ctx: AccessContext, quotas: list[QuotaSpec], first_week: date, weeks: int
) -> dict[str, Any]:
    """Weekly scores for each supplied quota. Completions are exact
    (casefolded) title matches: one per matching `practices_completed` entry
    on a daily check-in (timestamped at that date's midnight UTC, so a
    Monday-logged practice can repair the week before) and one per matching
    `activity_summary` session. A habit_quota intention whose title matches
    is cited alongside the completions it grounds."""
    checkins = _checkin_days(ctx)
    activities = _activities(ctx)
    intentions = optional_find(ctx, "intention")
    results: list[dict[str, Any]] = []
    cited: list[UUID] = []
    for spec in quotas:
        title = spec.title.casefold()
        completions: list[datetime] = []
        for day, entity in checkins:
            practices = entity.attributes.get("practices_completed")
            if not isinstance(practices, list):
                continue
            matches = [p for p in practices if isinstance(p, str) and p.casefold() == title]
            if matches:
                moment = datetime.combine(day, time.min, UTC)
                completions.extend([moment] * len(matches))
                cited.append(entity.id)
        for when, kind, entity_id in activities:
            if kind.casefold() == title:
                completions.append(when)
                cited.append(entity_id)
        cited.extend(
            i.id
            for i in intentions
            if i.attributes.get("kind") == "habit_quota"
            and str(i.attributes.get("title", "")).casefold() == title
        )
        scores = score_quota(
            spec.target_per_week, completions, first_week, weeks, spec.freeze_allowance
        )
        results.append(
            {
                "title": spec.title,
                "target_per_week": spec.target_per_week,
                "freeze_allowance": spec.freeze_allowance,
                "weeks": [
                    {
                        "week_start": s.week_start.isoformat(),
                        "count": s.count,
                        "repairs": s.repairs,
                        "status": s.status,
                    }
                    for s in scores
                ],
            }
        )
    return {"quotas": results, "provenance": _provenance(ctx, cited)}


def lapse_summary_rollup(ctx: AccessContext) -> dict[str, Any]:
    """Every >= 7-day check-in gap as measured facts only: the boundary
    dates, the missing-day count, and how many weight/activity records
    arrived inside the gap (their own timestamps, boundary days exclusive).
    Deliberately no other field: no cause, no reason, no narrative — the
    welcome-back summary reports what happened, never why."""
    checkins = _checkin_days(ctx)
    by_day = {day: entity for day, entity in checkins}
    weights = _weight_readings(ctx)
    activities = _activities(ctx)
    gaps: list[dict[str, Any]] = []
    cited: list[UUID] = []
    for gap in capture_gaps([day for day, _ in checkins]):
        in_gap_weights = [
            rid for when, _, rid in weights if gap.last_seen < when.date() < gap.resumed
        ]
        in_gap_activities = [
            rid for when, _, rid in activities if gap.last_seen < when.date() < gap.resumed
        ]
        gaps.append(
            {
                "last_seen": gap.last_seen.isoformat(),
                "resumed": gap.resumed.isoformat(),
                "gap_days": gap.gap_days,
                "weights_recorded": len(in_gap_weights),
                "activities_recorded": len(in_gap_activities),
            }
        )
        cited.extend([by_day[gap.last_seen].id, by_day[gap.resumed].id])
        cited.extend(in_gap_weights + in_gap_activities)
    return {"gaps": gaps, "provenance": _provenance(ctx, cited)}
