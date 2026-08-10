"""Rolling 30-day CPAP compliance: one deterministic service, zero LLM
(roadmap H2, ADR 019 rule 1).

`compute_compliance` is a pure function of a night's usage minutes and a
reference date. Nothing here reads a clock, calls a model, or predicts
anything: no prediction, no interpretation copy, no clinical advice (roadmap
H2 pre-made decisions, verbatim).

The compliance boolean is compared with `fractions.Fraction`, never a float
threshold, so a boundary night (e.g. exactly 21 of 30, exactly 70%) is never
miscounted by floating-point rounding — the exact failure class the DME
70%-of-nights rule exists to get right.
"""

from dataclasses import dataclass, field
from datetime import date, timedelta
from fractions import Fraction
from typing import Any
from uuid import UUID

from domains.cpap.types import DOMAIN
from domains.ops.common import optional_find
from kernel.access import AccessContext
from kernel.models import Entity

WINDOW_DAYS = 30
COMPLIANT_MINUTES = 4 * 60  # DME rule: "at least 4 hours"
LONG_NIGHT_MINUTES = 8 * 60
COMPLIANT_FRACTION = Fraction(70, 100)  # DME rule: "at least 70% of nights"

METHOD = "domains.cpap.compliance"


@dataclass(frozen=True)
class SessionUsage:
    """One night's usage, as the compliance math needs it."""

    session_date: date
    usage_min: int
    entity_id: UUID


@dataclass(frozen=True)
class ComplianceResult:
    as_of: date
    window_start: date
    window_days: int
    nights_with_data: int
    nights_missing: int
    nights_ge_4h: int
    nights_ge_8h: int
    pct_nights_ge_4h: float
    compliant: bool
    current_streak_nights: int
    full_month_streak: bool
    cited_entity_ids: list[UUID] = field(default_factory=list)


def compute_compliance(sessions: list[SessionUsage], as_of: date) -> ComplianceResult:
    """The rolling 30-consecutive-calendar-day compliance result ending at
    `as_of` (inclusive). Fixed 30-night denominator: a night with no session
    on record counts as non-compliant, never as excluded — that is the DME
    rule's own definition, not an approximation of it.
    """
    window_start = as_of - timedelta(days=WINDOW_DAYS - 1)
    by_date = {
        s.session_date: s for s in sessions if window_start <= s.session_date <= as_of
    }

    nights_with_data = len(by_date)
    nights_ge_4h = sum(1 for s in by_date.values() if s.usage_min >= COMPLIANT_MINUTES)
    nights_ge_8h = sum(1 for s in by_date.values() if s.usage_min >= LONG_NIGHT_MINUTES)
    compliant = Fraction(nights_ge_4h, WINDOW_DAYS) >= COMPLIANT_FRACTION

    streak = 0
    cursor = as_of
    while True:
        night = by_date.get(cursor)
        if night is None or night.usage_min <= 0:
            break
        streak += 1
        cursor -= timedelta(days=1)

    return ComplianceResult(
        as_of=as_of,
        window_start=window_start,
        window_days=WINDOW_DAYS,
        nights_with_data=nights_with_data,
        nights_missing=WINDOW_DAYS - nights_with_data,
        nights_ge_4h=nights_ge_4h,
        nights_ge_8h=nights_ge_8h,
        pct_nights_ge_4h=round(nights_ge_4h / WINDOW_DAYS, 4),
        compliant=compliant,
        current_streak_nights=streak,
        full_month_streak=streak >= WINDOW_DAYS,
        cited_entity_ids=sorted((s.entity_id for s in by_date.values()), key=str),
    )


def _to_usage(entity: Entity) -> SessionUsage | None:
    raw_date = entity.attributes.get("session_date")
    usage_min = entity.attributes.get("usage_min")
    if not isinstance(raw_date, str) or not isinstance(usage_min, int):
        return None
    try:
        session_date = date.fromisoformat(raw_date)
    except ValueError:
        return None
    return SessionUsage(session_date=session_date, usage_min=usage_min, entity_id=entity.id)


def compliance_for_briefing(ctx: AccessContext, as_of: date) -> ComplianceResult | None:
    """The compliance result the briefing cites, or None when this day's
    30-night window has no session data at all -- never a fabricated
    zero-compliance result for a source that has not reported anything near
    this date (the acceptance criterion: missing source data is an explicit
    absence, not fabricated data). Window-scoped exactly like the episodes
    line (`domains.episodes.lines.usual_present`): a partial window (some
    nights missing, most present) still returns a result, and
    `nights_missing` carries the gap honestly -- only a window with *zero*
    nights of data is silence."""
    sessions = [
        u for e in optional_find(ctx, "cpap_session") if (u := _to_usage(e)) is not None
    ]
    if not sessions:
        return None
    result = compute_compliance(sessions, as_of)
    return result if result.nights_with_data > 0 else None


def compliance_view(result: ComplianceResult) -> dict[str, Any]:
    """The briefing-attribute shape (domains.ops.types.BRIEFING_SCHEMA's
    `cpap_compliance` block): counts and booleans only, never a citation --
    the caller composes provenance the same way every other section does."""
    return {
        "window_days": result.window_days,
        "nights_with_data": result.nights_with_data,
        "nights_missing": result.nights_missing,
        "nights_ge_4h": result.nights_ge_4h,
        "nights_ge_8h": result.nights_ge_8h,
        "pct_nights_ge_4h": result.pct_nights_ge_4h,
        "compliant": result.compliant,
        "current_streak_nights": result.current_streak_nights,
        "full_month_streak": result.full_month_streak,
    }


def compliance_context() -> AccessContext:
    """Exactly the read scope this pure query needs -- no write scope on
    anything it reads, and it emits nothing of its own."""
    return AccessContext.of(f"{DOMAIN}:read")
