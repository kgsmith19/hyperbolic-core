"""Weekly review / briefing surface (05-e-lifeos.md section 2 candidate a,
selected; LO-3; m5-07). The ops.briefing cron already writes a daily
narrative and every scheduled job already leaves an execution_receipt
(ADR 014) -- nothing here is new data, only a read surface over both,
for an operator-chosen date range, plus a job-health flag so a missed
scheduled run is visible without querying entities by hand.

Read-only, like every other module in this domain (freshness.py,
adherence.py): no kernel table, no new persisted type, computed fresh on
every call from entities that already exist.
"""

from dataclasses import dataclass
from datetime import UTC, date, datetime
from uuid import UUID

from pydantic import BaseModel

from domains.calendar.autolink import METHOD as CALENDAR_AUTOLINK_JOB
from domains.calendar.ingest import METHOD as CALENDAR_INGEST_JOB
from domains.ops.briefing import METHOD as BRIEFING_JOB
from domains.ops.common import optional_find, parse_when
from kernel.access import AccessContext
from kernel.models import Entity

# The daily scheduled jobs ADR 014 covers (receipts.py's own docstring:
# "imported by every scheduled entry point"), the fixed registry this
# surface reports job health against -- a job added later earns a line
# here, the same way freshness.py's own SOURCE_* table is a fixed,
# code-defined list rather than inferred from whatever `job` strings
# happen to already exist in the receipt log. An inferred list could
# never report a job that has NEVER once run, which is exactly the case
# LO-3b exists to catch.
KNOWN_JOBS: tuple[str, ...] = (BRIEFING_JOB, CALENDAR_INGEST_JOB, CALENDAR_AUTOLINK_JOB)


class BriefingSummary(BaseModel):
    briefing_id: UUID
    date: str
    focus_intention_ids: list[str]
    appointment_ids: list[str]


class ReceiptSummary(BaseModel):
    receipt_id: UUID
    job: str
    started_at: str
    finished_at: str
    status: str
    summary: str


class JobHealth(BaseModel):
    job: str
    last_receipt_at: str | None
    last_status: str | None
    missed: bool


class ReviewFeed(BaseModel):
    start: str
    end: str
    briefings: list[BriefingSummary]
    receipts: list[ReceiptSummary]
    job_health: list[JobHealth]


@dataclass(frozen=True)
class _Dated:
    entity: Entity
    when: datetime


def _dated(entities: list[Entity], field: str) -> list[_Dated]:
    out = []
    for e in entities:
        when = parse_when(e.attributes.get(field))
        if when is not None:
            out.append(_Dated(e, when))
    return out


def _in_range(when: datetime, start: date, end: date) -> bool:
    return start <= when.date() <= end


def _briefing_summary(e: Entity) -> BriefingSummary:
    return BriefingSummary(
        briefing_id=e.id,
        date=str(e.attributes.get("date", "")),
        focus_intention_ids=[str(i) for i in e.attributes.get("focus_intention_ids", [])],
        appointment_ids=[str(i) for i in e.attributes.get("appointment_ids", [])],
    )


def _receipt_summary(e: Entity) -> ReceiptSummary:
    return ReceiptSummary(
        receipt_id=e.id,
        job=str(e.attributes.get("job", "")),
        started_at=str(e.attributes.get("started_at", "")),
        finished_at=str(e.attributes.get("finished_at", "")),
        status=str(e.attributes.get("status", "")),
        summary=str(e.attributes.get("summary", "")),
    )


def _job_health(job: str, receipts: list[_Dated], today: date) -> JobHealth:
    """Every KNOWN_JOBS entry is a daily cron (ADR 014); "its most recent
    slot" is read as today's calendar date. `missed` means no receipt of
    ANY status has `started_at` today -- an attempt that FAILED still
    proves the scheduler fired, so this flags "the scheduler never ran
    it" specifically, distinct from "it ran and failed" (which the
    receipt's own `status` already shows in the raw feed above). Judgment
    call, stated plainly: this codebase has no stored cron schedule to
    read a job's exact expected time from (an OS-level cron/timer, not
    kernel data), so "today" is the simplest slot definition that needs
    no such schedule and is directly checkable -- it can read `missed`
    for a few hours each morning before that day's run has actually
    fired, the same accepted-imprecision shape freshness.py's own fixed
    threshold table already carries for a different judgment call."""
    same_job = sorted(
        (r for r in receipts if r.entity.attributes.get("job") == job), key=lambda r: r.when
    )
    latest = same_job[-1] if same_job else None
    return JobHealth(
        job=job,
        last_receipt_at=str(latest.entity.attributes.get("started_at")) if latest else None,
        last_status=str(latest.entity.attributes.get("status")) if latest else None,
        missed=not any(r.when.date() == today for r in same_job),
    )


def review_feed(
    ctx: AccessContext, start: date, end: date, now: datetime | None = None
) -> ReviewFeed:
    """Briefings and execution receipts within [start, end] inclusive
    (LO-3a), plus a job-health flag for every KNOWN_JOBS entry (LO-3b)
    computed against "today" -- a live status, independent of the
    requested range, the same way a dashboard health panel outlives
    whatever date range happens to be selected."""
    if end < start:
        raise ValueError("end must not be before start")
    moment = now or datetime.now(UTC)
    today = moment.date()

    dated_briefings = _dated(optional_find(ctx, "briefing"), "date")
    briefings = sorted(
        (d for d in dated_briefings if _in_range(d.when, start, end)), key=lambda d: d.when
    )
    all_receipts = _dated(optional_find(ctx, "execution_receipt"), "started_at")
    ranged_receipts = sorted(
        (d for d in all_receipts if _in_range(d.when, start, end)), key=lambda d: d.when
    )

    return ReviewFeed(
        start=start.isoformat(),
        end=end.isoformat(),
        briefings=[_briefing_summary(d.entity) for d in briefings],
        receipts=[_receipt_summary(d.entity) for d in ranged_receipts],
        job_health=[_job_health(job, all_receipts, today) for job in KNOWN_JOBS],
    )


def review_context() -> AccessContext:
    """Exactly the read scopes the review feed needs -- no write scope on
    anything it reads, and it emits nothing of its own."""
    return AccessContext.of("ops:read")
