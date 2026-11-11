"""Persist metadata-only reconciliation receipts for source-sync plans (#588)."""

from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from kernel import db
from kernel.sync_plan import PlanAction, PlannedChange, SourceRecord
from kernel.sync_state import last_applied


@dataclass(frozen=True, slots=True)
class SyncReceipt:
    """The identifier and action totals for one persisted source-sync plan."""

    id: int
    counts: Mapping[PlanAction, int]


def summarize(plan: Iterable[PlannedChange]) -> dict[PlanAction, int]:
    """Count every supported plan action, explicitly including zeros."""
    counts = {action: 0 for action in PlanAction}
    for change in plan:
        counts[change.action] += 1
    return counts


def write_receipt(
    conn: db.Connection,
    records: Iterable[SourceRecord],
    plan: Iterable[PlannedChange],
) -> SyncReceipt:
    """Persist one ordered plan without changing applied source state."""
    batch = list(records)
    changes = list(plan)
    _validate_plan_matches_records(batch, changes)
    counts = summarize(changes)
    encoded_counts = {action.value: counts[action] for action in PlanAction}
    conn.execute(
        "insert into sync_receipt (created_at, counts) values (%s, %s)",
        (conn.tx_now(), db.Jsonb(encoded_counts)),
    )
    receipt_id = conn.execute("select last_insert_rowid() as id").fetchone()
    assert receipt_id is not None
    for ordinal, (record, change) in enumerate(zip(batch, changes, strict=True)):
        conn.execute(
            "insert into sync_receipt_item ("
            "receipt_id, ordinal, source, external_id, action, source_updated_at, "
            "previous_applied_at"
            ") values (%s, %s, %s, %s, %s, %s, %s)",
            (
                receipt_id["id"],
                ordinal,
                record.source,
                record.external_id,
                change.action.value,
                record.updated_at,
                last_applied(conn, record.source, record.external_id),
            ),
        )
    return SyncReceipt(id=receipt_id["id"], counts=counts)


def _validate_plan_matches_records(
    records: list[SourceRecord], changes: list[PlannedChange]
) -> None:
    if len(records) != len(changes) or any(
        (record.source, record.external_id) != (change.source, change.external_id)
        for record, change in zip(records, changes, strict=True)
    ):
        raise ValueError("plan does not match records")
