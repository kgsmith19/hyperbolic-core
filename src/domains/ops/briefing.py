"""The daily briefing: assembled, never generated (ADR 014, roadmap B3).

Deterministic and zero-LLM — today's appointments in chronological order, every
open ``link_review`` item awaiting a human, and the most recent
``daily_checkin`` if one exists. Display-only: no notification, no email, no
outbound request of any kind, and it writes nothing to anything it read.

It cites entity IDs and never copies the text they point at: no titles, no
locations, no attendee emails, no note text. An entity outlives what it quotes,
``entity.search`` is a tsvector over ``attributes::text`` and ``forget()`` is
per-entity, so a copied title would survive the erasure of its appointment
(invariant 9, ADR 012). A briefing is a pointer, so it degrades to "these ids
are gone" rather than to a lie.

Idempotent: a re-run assembles the same attributes and skips the capture, so
only the run's own execution receipt is new.

Runs as ``python -m domains.ops.briefing`` (deploy-box scheduler) under a
code-built AccessContext of exactly ``calendar:read`` + ``wellbeing:read`` +
``ops:read`` + ``ops:write`` — no write scope on anything it reads, so it cannot
modify calendar or wellbeing data by construction (ADR 014).
"""

from dataclasses import dataclass
from datetime import UTC, date, datetime, tzinfo
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from domains.ops.receipts import JobResult, run_job
from kernel import services
from kernel.access import AccessContext
from kernel.env import read_env
from kernel.models import Entity

METHOD = "domains.ops.briefing"


@dataclass
class BriefingReport:
    date: str
    briefing_id: UUID
    appointments: int
    open_reviews: int
    has_checkin: bool
    unchanged: bool = False

    def line(self) -> str:
        state = "unchanged" if self.unchanged else f"briefing={self.briefing_id}"
        return (
            f"briefing {self.date}: appointments={self.appointments} "
            f"open_reviews={self.open_reviews} checkin={'yes' if self.has_checkin else 'none'} "
            f"({state})"
        )


def briefing_zone() -> tzinfo:
    """ "Today" is a local date: `starts_at` is stored in UTC (ADR 012), so an
    evening appointment would otherwise land in tomorrow's briefing."""
    name = read_env("LIFEOS_BRIEFING_TZ")
    return ZoneInfo(name) if name else UTC


def _optional_find(ctx: AccessContext, type_name: str) -> list[Entity]:
    """Entities of a type that may not be defined yet — a fresh box has no
    calendar or wellbeing data until those slices' jobs have run. Absent type
    means an empty section, not a crashed briefing."""
    if type_name not in {t.name for t in services.list_types(ctx)}:
        return []
    return services.find(ctx, type_name=type_name)


def _starts_on(appointment: Entity, day: date, zone: tzinfo) -> bool:
    starts_at = appointment.attributes.get("starts_at")
    if not isinstance(starts_at, str):
        return False
    try:
        moment = datetime.fromisoformat(starts_at)
    except ValueError:
        return False
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(zone).date() == day


def _latest_event_ids(ctx: AccessContext, entity_ids: list[UUID]) -> list[str]:
    """The last event of each cited entity: the exact state this briefing saw is
    replayable from the log (ADR 010 provenance, invariants 2/3)."""
    latest = []
    for entity_id in entity_ids:
        events = services.history(ctx, entity_id)
        if events:
            latest.append(str(events[-1].id))
    return latest


def assemble(ctx: AccessContext, day: date, zone: tzinfo) -> dict[str, Any]:
    """Build one day's briefing attributes from kernel reads only."""
    appointments = sorted(
        (a for a in _optional_find(ctx, "appointment") if _starts_on(a, day, zone)),
        key=lambda a: str(a.attributes.get("starts_at", "")),
    )
    # Every link_review item is open: ADR 013 shipped the queue without a
    # resolve path, so nothing is closed yet. The filter lands with that path.
    reviews = _optional_find(ctx, "link_review")
    checkins = sorted(
        _optional_find(ctx, "daily_checkin"),
        key=lambda c: str(c.attributes.get("date", "")),
    )

    cited = [a.id for a in appointments] + [r.id for r in reviews]
    if checkins:
        cited.append(checkins[-1].id)
    attributes: dict[str, Any] = {
        "briefing_key": day.isoformat(),
        "date": day.isoformat(),
        "appointment_ids": [str(a.id) for a in appointments],
        "open_review_ids": [str(r.id) for r in reviews],
        "provenance": {
            "source_entity_ids": [str(i) for i in cited],
            "source_event_ids": _latest_event_ids(ctx, cited),
            "method": METHOD,
            "confidence": 1.0,
        },
    }
    if checkins:
        attributes["latest_checkin_id"] = str(checkins[-1].id)
    return attributes


def run_briefing(
    ctx: AccessContext, day: date | None = None, zone: tzinfo | None = None
) -> BriefingReport:
    """Assemble and store today's briefing. Unchanged input emits nothing."""
    zone = zone or briefing_zone()
    day = day or datetime.now(zone).date()
    attributes = assemble(ctx, day, zone)

    existing = services.find(ctx, type_name="briefing", filters={"briefing_key": day.isoformat()})
    if existing and existing[0].attributes == attributes:
        return BriefingReport(
            date=day.isoformat(),
            briefing_id=existing[0].id,
            appointments=len(attributes["appointment_ids"]),
            open_reviews=len(attributes["open_review_ids"]),
            has_checkin="latest_checkin_id" in attributes,
            unchanged=True,
        )
    result = services.capture(ctx, "briefing", attributes, actor=METHOD)
    return BriefingReport(
        date=day.isoformat(),
        briefing_id=result.entity_id,
        appointments=len(attributes["appointment_ids"]),
        open_reviews=len(attributes["open_review_ids"]),
        has_checkin="latest_checkin_id" in attributes,
    )


def briefing_context() -> AccessContext:
    """Exactly the scopes the briefing needs: read on the domains it summarizes,
    write only on its own (ADR 014)."""
    return AccessContext.of("calendar:read", "wellbeing:read", "ops:read", "ops:write")


def _job(ctx: AccessContext) -> JobResult:
    report = run_briefing(ctx)
    print(report.line())
    return JobResult(
        summary=report.line(), produced=[] if report.unchanged else [report.briefing_id]
    )


def main() -> int:
    return run_job(briefing_context(), METHOD, _job)


if __name__ == "__main__":
    raise SystemExit(main())
