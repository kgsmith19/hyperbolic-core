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
"""

from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel

from domains.intentions.planner import _priority_key
from domains.intentions.types import STATUS_CANDIDATE, TYPE_NAME
from kernel import services
from kernel.access import AccessContext
from kernel.events import DEFAULT_ACTOR
from kernel.models import Entity

ONE_OFF_LIMIT = 3
ANCHOR_KINDS = ("recurring_commitment", "habit_quota")
PROGRESS = ("READY", "STARTED", "BLOCKED", "WAITING", "DONE")
STALE_AFTER = timedelta(days=14)

Progress = Literal["READY", "STARTED", "BLOCKED", "WAITING", "DONE"]


class TodayItem(BaseModel):
    intention_id: UUID
    title: str
    kind: str
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
        focus=bool(a.get("focus", False)),
        progress=progress_of(a),  # type: ignore[arg-type]
        next_action=a.get("next_action") if isinstance(a.get("next_action"), str) else None,
        floor=a.get("floor") if isinstance(a.get("floor"), str) else None,
        updated_at=e.updated_at,
        stale=now - e.updated_at > STALE_AFTER,
    )


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
    return TodayView(
        as_of=now,
        one_offs=surfaced,
        more_one_offs=max(0, len(open_one_offs) - ONE_OFF_LIMIT),
        anchors=[_item(e, now) for e in anchors],
        next_two_minute_action=next_action,
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
