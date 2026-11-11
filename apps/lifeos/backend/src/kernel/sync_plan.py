"""Dry-run planning for source-to-kernel sync (#572).

Pure classification: nothing here writes kernel state or calls an external service.
Applying a plan is a separate, owner-approved step.
"""

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from uuid import UUID

from kernel.external_identity import IdentityCrosswalk


class PlanAction(StrEnum):
    CREATE = "create"
    UPDATE = "update"
    SKIP = "skip"
    STALE = "stale"
    CONFLICT = "conflict"


@dataclass(frozen=True, slots=True)
class SourceRecord:
    source: str
    external_id: str
    title: str
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class PlannedChange:
    action: PlanAction
    source: str
    external_id: str
    canonical_id: UUID | None
    reason: str


def plan_sync(
    records: Iterable[SourceRecord],
    crosswalk: IdentityCrosswalk,
    last_applied: Mapping[tuple[str, str], datetime],
) -> list[PlannedChange]:
    """Classify each record against the crosswalk and the last applied source timestamps.

    A repeated source identifier in one batch is a conflict for every copy, so a
    duplicate can never be applied twice or merged into another entity.
    """
    batch = list(records)
    counts: dict[tuple[str, str], int] = {}
    for record in batch:
        key = (record.source, record.external_id)
        counts[key] = counts.get(key, 0) + 1

    return [
        _classify(record, crosswalk, last_applied, duplicated=counts[_key(record)] > 1)
        for record in batch
    ]


def _key(record: SourceRecord) -> tuple[str, str]:
    return (record.source, record.external_id)


def _classify(
    record: SourceRecord,
    crosswalk: IdentityCrosswalk,
    last_applied: Mapping[tuple[str, str], datetime],
    *,
    duplicated: bool,
) -> PlannedChange:
    key = _key(record)
    if duplicated:
        return PlannedChange(
            PlanAction.CONFLICT, *key, None, "duplicate source identifier in batch"
        )
    canonical = crosswalk.resolve(*key)
    if canonical is None:
        return PlannedChange(PlanAction.CREATE, *key, None, "new source identifier")
    seen = last_applied.get(key)
    if seen is None:
        return PlannedChange(PlanAction.UPDATE, *key, canonical, "known identity, never applied")
    if record.updated_at < seen:
        return PlannedChange(PlanAction.STALE, *key, canonical, "source older than last applied")
    if record.updated_at == seen:
        return PlannedChange(PlanAction.SKIP, *key, canonical, "already applied at this timestamp")
    return PlannedChange(PlanAction.UPDATE, *key, canonical, "source changed since last applied")
