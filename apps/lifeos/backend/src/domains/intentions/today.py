"""The Today command center (#531, first slice).

At most three actionable one-off priorities, kept apart from the recurring
anchors, plus the next two-minute action and an explicit progress state.

- One-offs are every confirmed intention that is not an anchor kind and is
  not done, in planner priority order (focus first, then creation order).
  Only the first ``ONE_OFF_LIMIT`` are surfaced; the rest are counted, so
  they can be inspected without cluttering the day.
- Anchors (``recurring_commitment`` and ``habit_quota``) are never counted
  as one-offs.
- Progress is one of ``PROGRESS``. A change is a re-capture through the
  kernel's identity-match merge, so each one appends an ``entity.updated``
  event and history is never edited. ``DONE`` also sets the existing ``done``
  flag, and ``done`` alone still reads as ``DONE``, so the Tomorrow page and
  this view agree.
- An item untouched for ``STALE_AFTER`` is flagged stale. A still-unconfirmed
  candidate never appears here (the planner's rule).

Slice 2 adds the day's context, every part of it a live read through kernel
services (nothing here is stored, so titles are shown, never copied):

- ``balance``: open one-offs plus anchors per life area (``AREAS``), with
  untagged ones under ``unassigned``. A zero is shown, never hidden, so a
  neglected area is visible.
- ``schedule``: appointments starting on today's local date
  (``LIFEOS_BRIEFING_TZ``, the briefing's own zone), in time order.
- ``upcoming``: the next ``UPCOMING_LIMIT`` appointments in the following
  ``UPCOMING_DAYS`` days, with the rest counted.
- ``sources``: the scheduled jobs' health (``domains.ops.review``), so a
  stale calendar or a failed run is reported, not hidden behind an empty list.
- A section whose read scope the caller lacks is reported in ``unavailable``
  and left empty, instead of failing the whole view.
"""

from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel

from domains.intentions.planner import _priority_key
from domains.intentions.types import AREAS, STATUS_CANDIDATE, TYPE_NAME
from domains.ops.briefing import briefing_zone
from domains.ops.common import optional_find, parse_when
from domains.ops.review import JobHealth, job_health
from kernel import services
from kernel.access import AccessContext, has
from kernel.events import DEFAULT_ACTOR
from kernel.models import Entity

ONE_OFF_LIMIT = 3
ANCHOR_KINDS = ("recurring_commitment", "habit_quota")
PROGRESS = ("READY", "STARTED", "BLOCKED", "WAITING", "DONE")
STALE_AFTER = timedelta(days=14)
UPCOMING_DAYS = 7
UPCOMING_LIMIT = 5
UNASSIGNED = "unassigned"

Progress = Literal["READY", "STARTED", "BLOCKED", "WAITING", "DONE"]


class TodayItem(BaseModel):
    intention_id: UUID
    title: str
    kind: str
    area: str | None
    focus: bool
    progress: Progress
    next_action: str | None
    floor: str | None
    updated_at: datetime
    stale: bool


class TodayView(BaseModel):
    as_of: datetime
    one_offs: list[TodayItem]
    more_one_offs: int
    anchors: list[TodayItem]
    next_two_minute_action: str | None
    balance: dict[str, int]
    schedule: list["Appointment"]
    upcoming: list["Appointment"]
    more_upcoming: int
    sources: list[JobHealth]
    unavailable: list[str]


class Appointment(BaseModel):
    appointment_id: UUID
    # None once the title is erased (forget() strips x-pii): the slot stays.
    title: str | None
    starts_at: datetime
    all_day: bool


class ProgressChange(BaseModel):
    progress: Progress
    recorded_at: datetime
    actor: str


def progress_of(attributes: dict[str, Any]) -> str:
    value = attributes.get("progress")
    if attributes.get("done") is True:
        return "DONE"
    return value if value in PROGRESS else "READY"


def _item(e: Entity, now: datetime) -> TodayItem:
    a = e.attributes
    return TodayItem(
        intention_id=e.id,
        title=str(a.get("title", "")),
        kind=str(a.get("kind", "")),
        area=a.get("area") if a.get("area") in AREAS else None,
        focus=bool(a.get("focus", False)),
        progress=progress_of(a),  # type: ignore[arg-type]
        next_action=a.get("next_action") if isinstance(a.get("next_action"), str) else None,
        floor=a.get("floor") if isinstance(a.get("floor"), str) else None,
        updated_at=e.updated_at,
        stale=now - e.updated_at > STALE_AFTER,
    )


def _balance(entities: list[Entity]) -> dict[str, int]:
    counts = dict.fromkeys((*AREAS, UNASSIGNED), 0)
    for e in entities:
        area = e.attributes.get("area")
        counts[area if area in AREAS else UNASSIGNED] += 1
    return counts


def _appointments(
    ctx: AccessContext, now: datetime
) -> tuple[list[Appointment], list[Appointment], int]:
    """Today's appointments and the next ones after today, on the local date."""
    zone = briefing_zone()
    day = now.astimezone(zone).date()
    horizon = day + timedelta(days=UPCOMING_DAYS)
    dated: list[Appointment] = []
    for e in optional_find(ctx, "appointment"):
        if str(e.attributes.get("status", "")).upper() == "CANCELLED":
            continue
        starts_at = parse_when(e.attributes.get("starts_at"))
        if starts_at is None:
            continue
        title = e.attributes.get("title")
        dated.append(
            Appointment(
                appointment_id=e.id,
                title=title if isinstance(title, str) and title else None,
                starts_at=starts_at,
                all_day=e.attributes.get("all_day") is True,
            )
        )
    dated.sort(key=lambda a: a.starts_at)
    schedule = [a for a in dated if a.starts_at.astimezone(zone).date() == day]
    later = [a for a in dated if day < a.starts_at.astimezone(zone).date() <= horizon]
    return schedule, later[:UPCOMING_LIMIT], max(0, len(later) - UPCOMING_LIMIT)


def today(ctx: AccessContext, now: datetime | None = None) -> TodayView:
    now = now or datetime.now(UTC)
    confirmed = [
        e
        for e in services.find(ctx, type_name=TYPE_NAME)
        if e.attributes.get("status") != STATUS_CANDIDATE
    ]
    ordered = sorted(confirmed, key=_priority_key)
    anchors = [e for e in ordered if e.attributes.get("kind") in ANCHOR_KINDS]
    open_one_offs = [
        e
        for e in ordered
        if e.attributes.get("kind") not in ANCHOR_KINDS and progress_of(e.attributes) != "DONE"
    ]
    surfaced = [_item(e, now) for e in open_one_offs[:ONE_OFF_LIMIT]]
    next_action = next(
        (i.next_action for i in surfaced if i.next_action and i.progress != "BLOCKED"), None
    )
    unavailable: list[str] = []
    schedule: list[Appointment] = []
    upcoming: list[Appointment] = []
    more_upcoming = 0
    if has(ctx, "calendar:read"):
        schedule, upcoming, more_upcoming = _appointments(ctx, now)
    else:
        unavailable.append("calendar")
    sources: list[JobHealth] = []
    if has(ctx, "ops:read"):
        sources = job_health(ctx, now)
    else:
        unavailable.append("sources")
    return TodayView(
        as_of=now,
        one_offs=surfaced,
        more_one_offs=max(0, len(open_one_offs) - ONE_OFF_LIMIT),
        anchors=[_item(e, now) for e in anchors],
        next_two_minute_action=next_action,
        balance=_balance(open_one_offs + anchors),
        schedule=schedule,
        upcoming=upcoming,
        more_upcoming=more_upcoming,
        sources=sources,
        unavailable=unavailable,
    )


def set_progress(
    ctx: AccessContext, intention_id: UUID, progress: str, actor: str = DEFAULT_ACTOR
) -> TodayItem:
    """Record one progress change as an appended event; refuse anything off the list."""
    if progress not in PROGRESS:
        raise ValueError(f"progress must be one of {', '.join(PROGRESS)}")
    view = services.get_entity(ctx, intention_id)
    if TYPE_NAME not in view.types:
        raise ValueError(f"entity {intention_id} is not an {TYPE_NAME}")
    attributes: dict[str, Any] = {
        **view.entity.attributes,
        "progress": progress,
        "done": progress == "DONE",
    }
    result = services.capture(ctx, TYPE_NAME, attributes, actor=actor)
    return _item(services.get_entity(ctx, result.entity_id).entity, datetime.now(UTC))


def progress_history(ctx: AccessContext, intention_id: UUID) -> list[ProgressChange]:
    """Every recorded progress change for one intention, oldest first, from the event log."""
    changes: list[ProgressChange] = []
    last: str | None = None
    for event in services.history(ctx, intention_id):
        entity = event.payload.get("entity")
        attributes = entity.get("attributes") if isinstance(entity, dict) else None
        if not isinstance(attributes, dict):
            continue
        current = progress_of(attributes)
        if current != last:
            changes.append(
                ProgressChange(
                    progress=current,  # type: ignore[arg-type]
                    recorded_at=event.recorded_at,
                    actor=event.actor,
                )
            )
            last = current
    return changes
