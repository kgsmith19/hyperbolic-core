"""Master TODO Tracker import: dry-run plan, then idempotent candidate capture (#535).

The migration contract is apps/lifeos/docs/migration-contract.md. This module maps the
tracker's *structure*, never its content. The tracker text is the operator's and is passed
in by the caller (a local export). Nothing here reads Google Drive, and no test uses real
items.

Tracker shape: section headers (``OPEN``, ``NEXT``, ``LATER``/``REVIEW``, ``WAITING``,
``DONE``), then one task per line, ``[ ] TAG: text`` or ``[x] TAG: text``.

Mapping (the contract's table):

- An OPEN or NEXT item becomes a READY candidate. The first three OPEN items are flagged
  ``proposed_focus``, but focus is never set by an import: the operator confirms it.
- A WAITING item becomes a WAITING candidate.
- A LATER or REVIEW item becomes a candidate that is never plannable until confirmed. An
  unverified task is never assumed active.
- A DONE item, or a checked box, is skipped and counted. An import never marks anything
  DONE, because it has no completion evidence.
- An item whose tag is in ``exclude_tags`` is skipped and counted. Sensitive categories need
  their own narrow approved pathway.

Idempotency: ``title`` (``TAG: text``, trimmed to the schema limit) is the intention
identity. An existing title is skipped, so a repeat run writes nothing. Every capture is
``status: candidate``, ``focus: false``, ``source: tracker``. Rollback is a re-capture,
because events are append-only and nothing is deleted.
"""

import re
from collections.abc import Iterable
from dataclasses import dataclass, field

from domains.intentions.focus import capture_intention
from domains.intentions.types import MAX_ACTION, MAX_TITLE, STATUS_CANDIDATE, TYPE_NAME
from kernel import services
from kernel.access import AccessContext

JOB = "import-tracker"
SOURCE = "tracker"
FOCUS_PROPOSALS = 3

_SECTION = re.compile(r"^\s*(OPEN|NEXT|LATER|REVIEW|WAITING|DONE)\b", re.IGNORECASE)
_TASK = re.compile(r"^\s*\\?\[\s*(?P<mark>[ xX]?)\s*\\?\]\s*(?P<body>.+?)\s*$")
_TAG = re.compile(r"^(?P<tag>[A-Z][A-Z0-9 /&-]{0,40}):\s*(?P<rest>.+)$")


@dataclass(frozen=True)
class PlannedItem:
    title: str
    tag: str | None
    section: str
    progress: str
    plannable: bool
    proposed_focus: bool
    next_action: str


@dataclass
class TrackerPlan:
    items: list[PlannedItem] = field(default_factory=list)
    skipped_done: int = 0
    skipped_excluded: int = 0

    def counts(self) -> dict[str, int]:
        """Counts only: the report never carries item text."""
        return {
            "planned": len(self.items),
            "plannable": sum(1 for i in self.items if i.plannable),
            "proposed_focus": sum(1 for i in self.items if i.proposed_focus),
            "skipped_done": self.skipped_done,
            "skipped_excluded": self.skipped_excluded,
        }


def parse_tracker(text: str, exclude_tags: Iterable[str] = ()) -> TrackerPlan:
    excluded = {t.strip().upper() for t in exclude_tags}
    plan = TrackerPlan()
    section: str | None = None
    open_seen = 0
    for line in text.splitlines():
        task = _TASK.match(line)
        if task is None:
            header = _SECTION.match(line)
            if header:
                section = header.group(1).upper()
            continue
        if section is None:
            continue
        if task.group("mark").lower() == "x" or section == "DONE":
            plan.skipped_done += 1
            continue
        body = task.group("body")
        tagged = _TAG.match(body)
        tag = tagged.group("tag").strip().upper() if tagged else None
        if tag is not None and tag in excluded:
            plan.skipped_excluded += 1
            continue
        proposed_focus = section == "OPEN" and open_seen < FOCUS_PROPOSALS
        if section == "OPEN":
            open_seen += 1
        plan.items.append(
            PlannedItem(
                title=body[:MAX_TITLE],
                tag=tag,
                section=section,
                progress="WAITING" if section == "WAITING" else "READY",
                plannable=section in ("OPEN", "NEXT", "WAITING"),
                proposed_focus=proposed_focus,
                next_action=(tagged.group("rest") if tagged else body)[:MAX_ACTION],
            )
        )
    return plan


def apply_plan(ctx: AccessContext, plan: TrackerPlan) -> dict[str, int]:
    """Capture each new item as an unconfirmed candidate. Existing titles are never touched."""
    existing = {str(e.attributes.get("title")) for e in services.find(ctx, type_name=TYPE_NAME)}
    created = 0
    for item in plan.items:
        if item.title in existing:
            continue
        capture_intention(
            ctx,
            {
                "title": item.title,
                "kind": "task",
                "status": STATUS_CANDIDATE,
                "focus": False,
                "progress": item.progress,
                "next_action": item.next_action,
                "source": SOURCE,
            },
            actor=JOB,
        )
        existing.add(item.title)
        created += 1
    return {**plan.counts(), "created": created, "existing": len(plan.items) - created}
