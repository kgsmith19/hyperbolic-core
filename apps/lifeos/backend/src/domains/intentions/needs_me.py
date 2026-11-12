"""Needs Me queue (#532, first slice): the open items that need the operator next.

Pure ordering and visibility rules over intention entities, plus three writes
that each re-capture the SAME intention through the kernel's identity-match merge,
so every change appends one `entity.updated` event and history is never edited.

Rules held here:

- The queue never invents content. An item with no `next_action` is listed and
  flagged `no_next_action`; it is not given a guessed step.
- A deadline with no source is flagged `deadline_unsourced`, so a date is never
  presented as fact without where it came from.
- Snoozed items are hidden until their `snoozed_until` date, then return.
- Candidates, anchors (recurring commitments) and DONE items are never listed.
  Anchors stay on the Today view.
- Completion requires evidence: `complete` refuses without the operator's own
  confirmation text or a named external source. A status change alone never
  completes an item in this queue.
- Repeating an action that would change nothing writes no event (idempotent).
"""

from collections.abc import Iterable
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel

from domains.intentions.planner import _priority_key
from domains.intentions.today import ANCHOR_KINDS, progress_of
from domains.intentions.types import STATUS_CANDIDATE, TYPE_NAME
from kernel import services
from kernel.access import AccessContext
from kernel.events import DEFAULT_ACTOR
from kernel.models import Entity

FLAG_NO_NEXT_ACTION = "no_next_action"
FLAG_DEADLINE_UNSOURCED = "deadline_unsourced"

MAX_SOURCE = 200
MAX_EVIDENCE = 500


class NeedsMeItem(BaseModel):
    intention_id: UUID
    title: str
    next_action: str | None
    starter: str | None
    prerequisites: str | None
    deadline: date | None
    deadline_source: str | None
    snoozed_until: date | None
    flags: list[str]


def parse_date(value: Any) -> date | None:
    """An ISO YYYY-MM-DD string as a date; anything else is None, never guessed."""
    if not isinstance(value, str) or len(value) != 10:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def item_from(entity: Entity) -> NeedsMeItem:
    a = entity.attributes
    next_action = _text(a.get("next_action"))
    deadline = parse_date(a.get("deadline"))
    source = _text(a.get("deadline_source"))
    flags: list[str] = []
    if next_action is None:
        flags.append(FLAG_NO_NEXT_ACTION)
    if deadline is not None and source is None:
        flags.append(FLAG_DEADLINE_UNSOURCED)
    return NeedsMeItem(
        intention_id=entity.id,
        title=str(a.get("title", "")),
        next_action=next_action,
        starter=_text(a.get("starter")),
        prerequisites=_text(a.get("prerequisites")),
        deadline=deadline,
        deadline_source=source,
        snoozed_until=parse_date(a.get("snoozed_until")),
        flags=flags,
    )


def _is_listed(entity: Entity, today: date) -> bool:
    a = entity.attributes
    if a.get("status") == STATUS_CANDIDATE:
        return False
    if a.get("kind") in ANCHOR_KINDS:
        return False
    if progress_of(a) == "DONE":
        return False
    until = parse_date(a.get("snoozed_until"))
    return not (until is not None and until > today)


def queue(entities: Iterable[Entity], today: date) -> list[NeedsMeItem]:
    """Open items needing attention: dated ones first (soonest), then planner priority."""
    listed = [e for e in entities if _is_listed(e, today)]

    def order(entity: Entity) -> tuple[bool, date, bool, datetime]:
        deadline = parse_date(entity.attributes.get("deadline"))
        focus_rank, created = _priority_key(entity)
        return (deadline is None, deadline or date.max, focus_rank, created)

    return [item_from(e) for e in sorted(listed, key=order)]


# --- services -------------------------------------------------------------


def needs_me(ctx: AccessContext, today: date | None = None) -> list[NeedsMeItem]:
    today = today or datetime.now(UTC).date()
    return queue(services.find(ctx, type_name=TYPE_NAME), today)


def _apply(
    ctx: AccessContext, intention_id: UUID, changes: dict[str, Any], actor: str
) -> NeedsMeItem:
    view = services.get_entity(ctx, intention_id)
    if TYPE_NAME not in view.types:
        raise ValueError(f"entity {intention_id} is not an {TYPE_NAME}")
    current = view.entity.attributes
    merged = {**current, **changes}
    if merged == current:
        return item_from(view.entity)  # idempotent: nothing changes, nothing is written
    result = services.capture(ctx, TYPE_NAME, merged, actor=actor)
    return item_from(services.get_entity(ctx, result.entity_id).entity)


def snooze(
    ctx: AccessContext,
    intention_id: UUID,
    until: date,
    today: date | None = None,
    actor: str = DEFAULT_ACTOR,
) -> NeedsMeItem:
    today = today or datetime.now(UTC).date()
    if until <= today:
        raise ValueError("a snooze must end after today")
    return _apply(ctx, intention_id, {"snoozed_until": until.isoformat()}, actor)


def reschedule(
    ctx: AccessContext,
    intention_id: UUID,
    deadline: date,
    source: str,
    actor: str = DEFAULT_ACTOR,
) -> NeedsMeItem:
    named = source.strip()
    if not named:
        raise ValueError("a deadline needs its source: say where the date came from")
    if len(named) > MAX_SOURCE:
        raise ValueError(f"deadline source is limited to {MAX_SOURCE} characters")
    return _apply(
        ctx,
        intention_id,
        {"deadline": deadline.isoformat(), "deadline_source": named},
        actor,
    )


def complete(
    ctx: AccessContext, intention_id: UUID, evidence: str, actor: str = DEFAULT_ACTOR
) -> NeedsMeItem:
    proof = evidence.strip()
    if not proof:
        raise ValueError(
            "completion needs evidence: your own confirmation or a named external source"
        )
    if len(proof) > MAX_EVIDENCE:
        raise ValueError(f"completion evidence is limited to {MAX_EVIDENCE} characters")
    return _apply(
        ctx,
        intention_id,
        {"progress": "DONE", "done": True, "completion_evidence": proof},
        actor,
    )
