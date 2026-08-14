"""Intentions daily planner (LO-3d/LO-3e, m5-08): ordering the day's
intentions for the Tomorrow page, and a "mark done" write path.

"Priority order" composes two fields the domain already carries rather
than introducing a stored rank: focus first (the same signal
domains.ops.briefing's own assemble() already treats as the top
signal), then creation order within each group. The priority-list
import (import_priorities.py) captures each item in the operator's own
list order, one at a time, so creation order already IS the operator's
priority order for everything the import ever seeded -- nothing here
needs a separately stored rank to recover that.

"done" is a new field on the intention schema itself
(domains/intentions/types.py) -- a domain-level type-schema change, not
a kernel change (the issue's own "out of scope" wording is about
kernel/, not a domain's JSON schema, the same reading M4-20's own
domains/agents module relied on to add a brand-new type without
touching kernel/). `mark_done` re-captures the SAME intention entity
with `done: True` merged onto its EXISTING attributes, through
capture()'s own identity-match MERGE (kernel/services/capture.py): one
new `entity.updated` event is appended, and every prior event --
including the intention's original creation -- is untouched. "Marking
done never mutates history" is a property of the kernel's own write
path every domain in this codebase already relies on, not something
this module invents.

Re-import preservation (LO-3e) needs no new logic at all:
`import_priorities.run_import` already skips any title that already
exists, confirmed or not, done or not -- a re-import never re-captures
an existing intention, so a done-state, once set, survives any later
re-import of the same title by construction. See
tests/intentions/test_planner.py's own re-import case for the
behavioral proof.
"""

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel

from domains.intentions.types import STATUS_CANDIDATE, TYPE_NAME
from kernel import services
from kernel.access import AccessContext
from kernel.events import DEFAULT_ACTOR
from kernel.models import Entity


class PlannedIntention(BaseModel):
    intention_id: UUID
    title: str
    kind: str
    status: str
    focus: bool
    floor: str | None
    next_action: str | None
    done: bool
    created_at: datetime


def _view(e: Entity) -> PlannedIntention:
    a = e.attributes
    return PlannedIntention(
        intention_id=e.id,
        title=str(a.get("title", "")),
        kind=str(a.get("kind", "")),
        status=str(a.get("status", "")),
        focus=bool(a.get("focus", False)),
        floor=a.get("floor") if isinstance(a.get("floor"), str) else None,
        next_action=a.get("next_action") if isinstance(a.get("next_action"), str) else None,
        done=bool(a.get("done", False)),
        created_at=e.created_at,
    )


def _priority_key(e: Entity) -> tuple[bool, datetime]:
    # `not focus` sorts True (unfocused) after False (focused), so focus
    # goals lead; `created_at` breaks ties in creation/import order.
    return (not bool(e.attributes.get("focus", False)), e.created_at)


def plan_today(ctx: AccessContext) -> list[PlannedIntention]:
    """The operator's plannable intentions, ordered by priority: focus
    goals first, then creation order within each group. A still-
    unconfirmed candidate (status == STATUS_CANDIDATE, the priority-list
    import's own seed state) is not yet something the operator agreed to
    plan a day around -- it stays on the review-and-confirm path (the
    capture UI), not this list."""
    all_intentions = services.find(ctx, type_name=TYPE_NAME)
    intentions = [e for e in all_intentions if e.attributes.get("status") != STATUS_CANDIDATE]
    return [_view(e) for e in sorted(intentions, key=_priority_key)]


def mark_done(
    ctx: AccessContext, intention_id: UUID, actor: str = DEFAULT_ACTOR
) -> PlannedIntention:
    """Append one entity.updated event recording done=True for this
    intention. Every existing field survives unchanged (capture()'s own
    identity-match merge, above); no past event is ever edited."""
    view = services.get_entity(ctx, intention_id)
    if TYPE_NAME not in view.types:
        raise ValueError(f"entity {intention_id} is not an {TYPE_NAME}")
    attributes: dict[str, Any] = {**view.entity.attributes, "done": True}
    result = services.capture(ctx, TYPE_NAME, attributes, actor=actor)
    return _view(services.get_entity(ctx, result.entity_id).entity)
