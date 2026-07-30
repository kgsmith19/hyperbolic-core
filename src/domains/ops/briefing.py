"""The daily briefing: assembled, never generated (ADR 014; recomposed in INT1).

Deterministic and zero-LLM — the ONE morning digest (ADR 019 rule 1), in the
roadmap §INT1 composition order: the focus intentions first (at most three by
the focus rule; their entities carry the floors and next physical actions),
then today's appointments in chronological order, then the EP1 episodes line
when it has something to say — ONE descriptive line, a count in words computed
by the episodes cell (`domains.episodes.lines.usual_present`), historical
language only, never a tag name; when the count is zero the key is absent
entirely, because a scheduled zero-count would put episode salience on a
notification-adjacent path (the episodes cell is pull-only) — then nothing
else until the data for later sections exists (CPAP compliance joins after
H2). The open-review and latest-check-in pointers B3 shipped left the
digest with that recomposition: feelings are pull-only, so nothing on a
notification path references mood or symptoms (rule 1), and the digest carries
no overdue or backlog counts (rule 2 — restart-neutral). The Monday edition
additionally reports utility-gate status (rule 9): days-with-a-check-in per
week over the four complete weeks behind it, counts and a met boolean, computed
from kernel data — quota scores wait on D1 and months-of-cover on the C0.5
rider. Display-only: no notification, no email, no outbound request of any
kind, and it writes nothing to anything it read. An existing database needs
``scripts/migrate_briefing_composition.py`` once before the first recomposed
run.

It cites entity IDs and never copies the text they point at: no titles, no
locations, no attendee emails, no note text. An entity outlives what it quotes,
``entity.search`` is a tsvector over ``attributes::text`` and ``forget()`` is
per-entity, so a copied title would survive the erasure of its appointment
(invariant 9, ADR 012). A briefing is a pointer, so it degrades to "these ids
are gone" rather than to a lie.

Idempotent: a re-run assembles the same attributes and skips the capture, so
only the run's own execution receipt is new.

Runs as ``python -m domains.ops.briefing`` (deploy-box scheduler) under a
code-built AccessContext of exactly ``intentions:read`` + ``calendar:read`` +
``wellbeing:read`` + ``episodes:read`` + ``ops:read`` + ``ops:write`` — no
write scope on anything it reads, so it cannot modify intention, calendar,
wellbeing or episode data by construction (ADR 014, amended by INT1 and EP1).
"""

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta, tzinfo
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from domains.episodes.lines import usual_present
from domains.ops.receipts import JobResult, run_job
from domains.ops.types import GATE_DAYS_PER_WEEK, GATE_WEEKS
from kernel import services
from kernel.access import AccessContext
from kernel.env import read_env
from kernel.models import Entity

METHOD = "domains.ops.briefing"


@dataclass
class BriefingReport:
    date: str
    briefing_id: UUID
    focus: int
    appointments: int
    gate: str | None = None  # "met" | "open" on the Monday (weekly) edition
    unchanged: bool = False

    def line(self) -> str:
        state = "unchanged" if self.unchanged else f"briefing={self.briefing_id}"
        gate = f" gate={self.gate}" if self.gate else ""
        return (
            f"briefing {self.date}: focus={self.focus} "
            f"appointments={self.appointments}{gate} ({state})"
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


def _gate_status(ctx: AccessContext, day: date) -> tuple[dict[str, Any], list[Entity]]:
    """Utility-gate status (ADR 019 rule 9) for the Monday edition: days of use
    per week over the GATE_WEEKS complete Mon-Sun weeks before `day`, and
    whether every week reached GATE_DAYS_PER_WEEK. "Use" is a day with a
    ``daily_checkin`` — the only operator-authored daily record in kernel data
    today; widen the signal when other surfaces record operator actions. One
    entity per date by identity, so counting entities counts days. Returns the
    status and the check-ins it counted, so they can be cited (ADR 010)."""
    window_start = day - timedelta(days=7 * GATE_WEEKS)
    counts = [0] * GATE_WEEKS
    counted: list[Entity] = []
    for checkin in _optional_find(ctx, "daily_checkin"):
        raw = checkin.attributes.get("date")
        if not isinstance(raw, str):
            continue
        try:
            offset = (date.fromisoformat(raw) - window_start).days
        except ValueError:
            continue
        if 0 <= offset < 7 * GATE_WEEKS:
            counts[offset // 7] += 1
            counted.append(checkin)
    met = all(count >= GATE_DAYS_PER_WEEK for count in counts)
    return {"weeks": counts, "met": met}, counted


def assemble(ctx: AccessContext, day: date, zone: tzinfo) -> dict[str, Any]:
    """Build one day's briefing attributes from kernel reads only, in the
    roadmap §INT1 composition order: focus intentions, then calendar context,
    then nothing else (the Monday edition appends gate status)."""
    focus = sorted(
        (i for i in _optional_find(ctx, "intention") if i.attributes.get("focus") is True),
        key=lambda i: str(i.attributes.get("title", "")),
    )
    appointments = sorted(
        (a for a in _optional_find(ctx, "appointment") if _starts_on(a, day, zone)),
        key=lambda a: str(a.attributes.get("starts_at", "")),
    )

    cited = [i.id for i in focus] + [a.id for a in appointments]
    attributes: dict[str, Any] = {
        "briefing_key": day.isoformat(),
        "date": day.isoformat(),
        "focus_intention_ids": [str(i.id) for i in focus],
        "appointment_ids": [str(a.id) for a in appointments],
    }
    # The EP1 episodes line: a count in words, or no key at all (see the
    # module docstring). The semantics live in the episodes cell; this job
    # only reads and stores — the line carries no tag, no date, no id, and
    # the contributing episodes are cited like every other section.
    episode_line = usual_present(_optional_find(ctx, "episode"), day)
    if episode_line is not None:
        text, contributing = episode_line
        attributes["episodes_line"] = text
        cited += [e.id for e in contributing]
    if day.isoweekday() == 1:  # Monday: the weekly edition
        gate, counted = _gate_status(ctx, day)
        attributes["gate"] = gate
        cited += [c.id for c in counted]
    attributes["provenance"] = {
        "source_entity_ids": [str(i) for i in cited],
        "source_event_ids": _latest_event_ids(ctx, cited),
        "method": METHOD,
        "confidence": 1.0,
    }
    return attributes


def _report(
    day: date, briefing_id: UUID, attributes: dict[str, Any], unchanged: bool = False
) -> BriefingReport:
    gate = attributes.get("gate")
    return BriefingReport(
        date=day.isoformat(),
        briefing_id=briefing_id,
        focus=len(attributes["focus_intention_ids"]),
        appointments=len(attributes["appointment_ids"]),
        gate=None if gate is None else ("met" if gate["met"] else "open"),
        unchanged=unchanged,
    )


def run_briefing(
    ctx: AccessContext, day: date | None = None, zone: tzinfo | None = None
) -> BriefingReport:
    """Assemble and store today's briefing. Unchanged input emits nothing."""
    zone = zone or briefing_zone()
    day = day or datetime.now(zone).date()
    attributes = assemble(ctx, day, zone)

    existing = services.find(ctx, type_name="briefing", filters={"briefing_key": day.isoformat()})
    # Compare only the keys assemble produced: capture MERGES onto an identity
    # match, so a key assemble no longer emits (the B3 composition's
    # open_review_ids / latest_checkin_id, on a briefing stored before the
    # INT1 recomposition) lingers on the stored entity forever. Whole-dict
    # equality would then never hold again and the briefing would re-capture
    # on every run.
    if existing and {k: existing[0].attributes.get(k) for k in attributes} == attributes:
        return _report(day, existing[0].id, attributes, unchanged=True)
    result = services.capture(ctx, "briefing", attributes, actor=METHOD)
    return _report(day, result.entity_id, attributes)


def briefing_context() -> AccessContext:
    """Exactly the scopes the briefing needs: read on the domains it summarizes,
    write only on its own (ADR 014, amended by INT1 and EP1)."""
    return AccessContext.of(
        "intentions:read",
        "calendar:read",
        "wellbeing:read",
        "episodes:read",
        "ops:read",
        "ops:write",
    )


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
