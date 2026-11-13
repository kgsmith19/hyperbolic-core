"""Apply a planned source-sync batch from its reconciliation receipt (#572).

The counterpart of ``sync_rollback``. Dry run is the default: planning reads the
receipt and the applied state and returns the steps without writing anything. A
real apply re-checks every precondition before its first write, then writes the
applied state and marks the receipt applied in the same transaction, so a refusal
leaves no partial state behind.

Only ``create`` and ``update`` items are applied. Each one must still find the
applied state the plan saw (``previous_applied_at``); if anything moved since the
plan, the whole batch is refused and must be planned again. A receipt is applied
at most once, and a rolled-back receipt is never re-applied, so a second apply of
the same batch can never duplicate a write. Re-planning the same records after an
apply yields only ``skip``: the zero-duplicate second run.
"""

from dataclasses import dataclass
from datetime import datetime

from kernel import db
from kernel.sync_plan import PlanAction
from kernel.sync_state import last_applied, record_applied

_TOUCHED = (PlanAction.CREATE.value, PlanAction.UPDATE.value)


class ApplyRefused(ValueError):
    """The receipt cannot be applied; nothing was written."""


@dataclass(frozen=True, slots=True)
class ApplyStep:
    source: str
    external_id: str
    applied_at: datetime  # the source timestamp being recorded
    previous: datetime | None  # what the plan saw, and what is there now


def plan_apply(conn: db.Connection, receipt_id: int) -> list[ApplyStep]:
    """Return the steps that would apply ``receipt_id``, or refuse. Writes nothing."""
    receipt = conn.execute(
        "select applied_at from sync_receipt where id = %s", (receipt_id,)
    ).fetchone()
    if receipt is None:
        raise ApplyRefused(f"unknown receipt {receipt_id}")
    if receipt["applied_at"] is not None:
        raise ApplyRefused(f"receipt {receipt_id} was already applied")
    rolled_back = conn.execute(
        "select 1 as found from sync_receipt_rollback where receipt_id = %s", (receipt_id,)
    ).fetchone()
    if rolled_back is not None:
        raise ApplyRefused(f"receipt {receipt_id} was rolled back; plan a new batch")

    items = conn.execute(
        "select source, external_id, action, source_updated_at, previous_applied_at "
        "from sync_receipt_item where receipt_id = %s order by ordinal",
        (receipt_id,),
    ).fetchall()
    steps: list[ApplyStep] = []
    for item in items:
        if item["action"] not in _TOUCHED:
            continue
        current = last_applied(conn, item["source"], item["external_id"])
        if current != item["previous_applied_at"]:
            raise ApplyRefused(
                f"applied state of {item['source']}/{item['external_id']} "
                f"moved since batch {receipt_id} was planned"
            )
        steps.append(
            ApplyStep(
                source=item["source"],
                external_id=item["external_id"],
                applied_at=item["source_updated_at"],
                previous=item["previous_applied_at"],
            )
        )
    return steps


def apply(conn: db.Connection, receipt_id: int, *, dry_run: bool = True) -> list[ApplyStep]:
    """Plan an apply; with ``dry_run=False`` also apply it in this transaction."""
    steps = plan_apply(conn, receipt_id)
    if dry_run:
        return steps
    for step in steps:
        record_applied(conn, step.source, step.external_id, step.applied_at)
    conn.execute(
        "update sync_receipt set applied_at = %s where id = %s", (conn.tx_now(), receipt_id)
    )
    return steps
