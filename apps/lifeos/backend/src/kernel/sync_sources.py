"""Read-only mapping from fetched source records to planner inputs (#572).

Callers fetch the raw payloads; this module only shapes them. It makes no
network call and writes nothing. Missing identity or time fails closed.
"""

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from kernel.sync_plan import SourceRecord

GOOGLE_DRIVE = "google-drive"
GOOGLE_TASKS = "google-tasks"


def drive_file_record(payload: Mapping[str, Any]) -> SourceRecord:
    return SourceRecord(
        source=GOOGLE_DRIVE,
        external_id=_required(payload, "id"),
        title=_required(payload, "name"),
        updated_at=_utc(_required(payload, "modifiedTime")),
    )


def google_task_record(payload: Mapping[str, Any]) -> SourceRecord:
    return SourceRecord(
        source=GOOGLE_TASKS,
        external_id=_required(payload, "id"),
        title=_required(payload, "title"),
        updated_at=_utc(_required(payload, "updated")),
    )


def _required(payload: Mapping[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"source payload is missing a nonblank {key!r}")
    return value


def _utc(stamp: str) -> datetime:
    parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("source timestamp must include a timezone")
    return parsed.astimezone(UTC)
