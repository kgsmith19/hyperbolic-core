"""Operations Registry records in the kernel: ManualBlockers and Task Registry rows (#630).

A read-only, deterministic projection of the canonical Google Sheet tabs into typed
`registry_record` entities, so Needs Me and the morning briefing can cite them. The sheet stays
the task master (README SHARED CONTRACT v1); LifeOS never writes back and never becomes a second
writable task store. Callers fetch the rows (header row plus data rows); this module makes no
network call (`scripts/import_registry.py` captures an exported snapshot).

Rules held here:

- Identity is the row's immutable external ID (`MB-011`, `P-01`), namespaced by tab:
  `record_key = "<kind>:<external_id>"`. Rows are never joined by title. A duplicate ID within a
  tab is refused, never merged.
- Columns are found by exact header text (whitespace and case ignored), never by position. A
  missing or doubled required column refuses the whole tab.
- Nothing is invented: `next_action` and `deadline` are copied only when the row has them, and a
  deadline that is not an ISO date, or has no evidence/source on its row, is flagged rather than
  trusted.
- Status: closed states (resolved, done, cancelled) leave Needs Me; `WATCH` (automation is on it)
  and `LATER` (planning bucket) are not "needs me"; an unknown status is listed with the
  `status_unknown` flag. It is never treated as complete.
- Capturing an unchanged row writes nothing (idempotent).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Any
from uuid import UUID

from kernel import services
from kernel.access import AccessContext
from kernel.models import Entity

TYPE_NAME = "registry_record"
KIND_MANUAL_BLOCKER = "manual_blocker"
KIND_TASK = "task"
SOURCE_SHEET = "operations-registry"

STATE_OPEN = "open"
STATE_WATCH = "watch"
STATE_LATER = "later"
STATE_CLOSED = "closed"
STATE_UNKNOWN = "unknown"
LISTED_STATES = (STATE_OPEN, STATE_UNKNOWN)

FLAG_STATUS_UNKNOWN = "status_unknown"
FLAG_NO_NEXT_ACTION = "no_next_action"
FLAG_DEADLINE_UNSOURCED = "deadline_unsourced"

MAX_TEXT = 500
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

# Leading status token -> state. Manual Blockers statuses carry prose after the token
# ("RESOLVED 2026-11-13: ..."); Task Registry statuses are bare.
_MANUAL_BLOCKER_STATES = {
    "RESOLVED": STATE_CLOSED,
    "CLOSED": STATE_CLOSED,
    "OPEN": STATE_OPEN,
    "READY": STATE_OPEN,
    "BLOCKED": STATE_OPEN,
    "WATCH": STATE_WATCH,
}
_TASK_STATES = {
    "INBOX": STATE_OPEN,
    "TRIAGED": STATE_OPEN,
    "READY": STATE_OPEN,
    "IN_PROGRESS": STATE_OPEN,
    "WAITING": STATE_OPEN,
    "BLOCKED": STATE_OPEN,
    "LATER": STATE_LATER,
    "DONE": STATE_CLOSED,
    "CANCELLED": STATE_CLOSED,
    "CANCELED": STATE_CLOSED,
}

# Required column -> accepted header texts (normalized), per tab.
_MANUAL_BLOCKER_COLUMNS: dict[str, tuple[str, ...]] = {
    "id": ("blocker id",),
    "status": ("status",),
    "title": ("work item",),
    "next_action": ("minimum human action",),
    "owner": ("owner",),
}
_MANUAL_BLOCKER_OPTIONAL: dict[str, tuple[str, ...]] = {"source": ("source",)}
_TASK_COLUMNS: dict[str, tuple[str, ...]] = {
    "id": ("task id",),
    "status": ("status",),
    "title": ("title",),
    "next_action": ("next action",),
    "owner": ("owner",),
    "deadline": ("deadline",),
    "evidence": ("evidence / source",),
}

REGISTRY_RECORD_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "record_key": {"type": "string", "maxLength": 96},
        "kind": {"type": "string", "enum": [KIND_MANUAL_BLOCKER, KIND_TASK]},
        "external_id": {"type": "string", "maxLength": 64},
        "source": {"type": "string", "maxLength": 64},
        "source_url": {"type": "string", "maxLength": MAX_TEXT},
        "title": {"type": "string", "maxLength": MAX_TEXT},
        "status_text": {"type": "string", "maxLength": MAX_TEXT},
        "state": {
            "type": "string",
            "enum": [STATE_OPEN, STATE_WATCH, STATE_LATER, STATE_CLOSED, STATE_UNKNOWN],
        },
        "owner": {"type": "string", "maxLength": 120},
        "next_action": {"type": "string", "maxLength": MAX_TEXT},
        "deadline": {"type": "string", "maxLength": 32},
        "deadline_source": {"type": "string", "maxLength": MAX_TEXT},
        "flags": {"type": "array", "items": {"type": "string", "maxLength": 32}, "maxItems": 8},
    },
    "required": ["record_key", "kind", "external_id", "source", "title", "state", "flags"],
    "additionalProperties": False,
    "x-identity": ["record_key"],
}


class RegistryShapeError(ValueError):
    """A tab cannot be shaped: missing or doubled column, or a duplicate/invalid row ID."""


@dataclass(frozen=True)
class RegistryRecord:
    kind: str
    external_id: str
    title: str
    status_text: str
    state: str
    owner: str
    next_action: str | None
    deadline: str | None
    deadline_source: str | None
    source_url: str | None
    flags: tuple[str, ...] = field(default_factory=tuple)

    @property
    def record_key(self) -> str:
        return f"{self.kind}:{self.external_id}"

    def attributes(self) -> dict[str, Any]:
        attrs: dict[str, Any] = {
            "record_key": self.record_key,
            "kind": self.kind,
            "external_id": self.external_id,
            "source": SOURCE_SHEET,
            "title": self.title,
            "status_text": self.status_text,
            "state": self.state,
            "owner": self.owner,
            "flags": list(self.flags),
        }
        for key in ("next_action", "deadline", "deadline_source", "source_url"):
            value = getattr(self, key)
            if value:
                attrs[key] = value
        return attrs


def _normalize(cell: object) -> str:
    return " ".join(str(cell or "").split()).lower()


def _text(cell: object) -> str:
    return " ".join(str(cell or "").split())[:MAX_TEXT]


def _index(
    header: Sequence[object], columns: dict[str, tuple[str, ...]], required: bool
) -> dict[str, int]:
    normalized = [_normalize(c) for c in header]
    found: dict[str, int] = {}
    for column, names in columns.items():
        hits = [i for i, cell in enumerate(normalized) if cell in names]
        if len(hits) > 1:
            raise RegistryShapeError(f"header names the {column!r} column more than once")
        if not hits:
            if required:
                raise RegistryShapeError(f"header is missing the {column!r} column")
            continue
        found[column] = hits[0]
    return found


def _cell(row: Sequence[object], index: dict[str, int], column: str) -> str:
    i = index.get(column)
    return _text(row[i]) if i is not None and i < len(row) else ""


def _state(status_text: str, table: dict[str, str]) -> str:
    token = re.split(r"[\s:(→,]", status_text.strip().upper(), maxsplit=1)[0] if status_text else ""
    return table.get(token, STATE_UNKNOWN)


def _iso(value: str) -> str | None:
    try:
        return date.fromisoformat(value).isoformat() if len(value) == 10 else None
    except ValueError:
        return None


def _shape(
    kind: str,
    rows: Sequence[Sequence[object]],
    columns: dict[str, tuple[str, ...]],
    optional: dict[str, tuple[str, ...]],
    states: dict[str, str],
) -> list[RegistryRecord]:
    if not rows:
        return []
    header, data = rows[0], rows[1:]
    index = {**_index(header, columns, True), **_index(header, optional, False)}
    seen: set[str] = set()
    records: list[RegistryRecord] = []
    for row in data:
        external_id = _cell(row, index, "id")
        if not external_id:
            continue  # spacer or section row: no identity, nothing to shape
        if not _ID.match(external_id):
            raise RegistryShapeError(f"row ID {external_id!r} is not a valid identifier")
        if external_id in seen:
            raise RegistryShapeError(f"{kind} {external_id} appears more than once")
        seen.add(external_id)
        owner = _cell(row, index, "owner")
        if _iso(owner) or owner.lower().startswith(("http://", "https://")):
            # A date or link where the owner belongs means the row's cells are shifted (a
            # missing cell earlier in the row). Refuse the tab rather than mis-file the row.
            raise RegistryShapeError(
                f"{kind} {external_id}: the owner cell holds a date or link; columns look shifted"
            )
        status_text = _cell(row, index, "status")
        state = _state(status_text, states)
        next_action = _cell(row, index, "next_action") or None
        flags: list[str] = []
        if state == STATE_UNKNOWN:
            flags.append(FLAG_STATUS_UNKNOWN)
        if next_action is None:
            flags.append(FLAG_NO_NEXT_ACTION)
        deadline_raw = _cell(row, index, "deadline")
        evidence = _cell(row, index, "evidence") or None
        parsed = _iso(deadline_raw) if deadline_raw else None
        # A date is kept only with its source on the same row; otherwise it is flagged, never shown.
        deadline = parsed if parsed and evidence else None
        if deadline_raw and deadline is None:
            flags.append(FLAG_DEADLINE_UNSOURCED)
        records.append(
            RegistryRecord(
                kind=kind,
                external_id=external_id,
                title=_cell(row, index, "title"),
                status_text=status_text,
                state=state,
                owner=owner[:120],
                next_action=next_action,
                deadline=deadline,
                deadline_source=evidence if deadline else None,
                source_url=_cell(row, index, "source") or None,
                flags=tuple(flags),
            )
        )
    return records


def manual_blockers(rows: Sequence[Sequence[object]]) -> list[RegistryRecord]:
    """The Manual Blockers tab: header row first (its title/description rows already removed)."""
    return _shape(
        KIND_MANUAL_BLOCKER,
        rows,
        _MANUAL_BLOCKER_COLUMNS,
        _MANUAL_BLOCKER_OPTIONAL,
        _MANUAL_BLOCKER_STATES,
    )


def task_registry(rows: Sequence[Sequence[object]]) -> list[RegistryRecord]:
    """The Task Registry tab: header row first."""
    return _shape(KIND_TASK, rows, _TASK_COLUMNS, {}, _TASK_STATES)


def from_tab(rows: Sequence[Sequence[object]], marker: str) -> list[Sequence[object]]:
    """Drop the title/description rows above a tab's header (the row whose first cell is
    `marker`, e.g. "Blocker ID"). Refuses a tab with no such header."""
    for i, row in enumerate(rows):
        if row and _normalize(row[0]) == _normalize(marker):
            return list(rows[i:])
    raise RegistryShapeError(f"no header row starting with {marker!r}")


@dataclass(frozen=True)
class CaptureReport:
    captured: int
    unchanged: int


def capture(ctx: AccessContext, records: Iterable[RegistryRecord], actor: str) -> CaptureReport:
    """Upsert each record by `record_key`; an unchanged record writes nothing."""
    services.define_missing(ctx, "ops", {TYPE_NAME: REGISTRY_RECORD_SCHEMA})
    captured = unchanged = 0
    for record in records:
        attrs = record.attributes()
        existing = services.find(
            ctx, type_name=TYPE_NAME, filters={"record_key": record.record_key}
        )
        if (
            existing
            and {k: existing[0].attributes.get(k) for k in attrs} == attrs
            and set(existing[0].attributes) <= set(attrs)
        ):
            unchanged += 1
            continue
        services.capture(ctx, TYPE_NAME, attrs, actor=actor)
        captured += 1
    return CaptureReport(captured=captured, unchanged=unchanged)


def _needs_operator(entity: Entity, operator: str) -> bool:
    a = entity.attributes
    if a.get("state") not in LISTED_STATES:
        return False
    owner = str(a.get("owner") or "")
    return not owner or operator.lower() in owner.lower()


def needs_me(entities: Iterable[Entity], operator: str = "Kyle") -> list[Entity]:
    """Open records that need the operator: dated ones first (soonest), then blockers, then tasks,
    then by external ID, so the order is stable run to run."""
    listed = [e for e in entities if _needs_operator(e, operator)]

    def order(e: Entity) -> tuple[bool, str, int, str]:
        a = e.attributes
        deadline = a.get("deadline")
        return (
            deadline is None,
            str(deadline or ""),
            0 if a.get("kind") == KIND_MANUAL_BLOCKER else 1,
            str(a.get("external_id")),
        )

    return sorted(listed, key=order)


def entity_ids(entities: Iterable[Entity]) -> list[UUID]:
    return [e.id for e in entities]
