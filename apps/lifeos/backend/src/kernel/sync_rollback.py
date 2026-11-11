"""Roll back an applied source-sync batch from its reconciliation receipt (#589).

Dry run is the default. Planning reads the receipt and the applied state and
returns the steps without writing anything. A real rollback re-checks every
precondition before its first write, then applies the steps and records the
rollback in the same transaction, so a refusal leaves no partial state behind.

Only ``create`` and ``update`` items are touched. ``skip``, ``stale`` and
``conflict`` items never changed applied state, so rollback leaves them alone.
"""

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum

from kernel import db
from kernel.sync_plan import PlanAction
from kernel.sync_state import last_applied

_TOUCHED = (PlanAction.CREATE.value, PlanAction.UPDATE.value)


class RollbackRefused(ValueError):
    """The receipt cannot be rolled back; nothing was written."""


class StepKind(StrEnum):
    CLEAR = "clear"  # the batch created this applied state: delete it
    RESTORE = "restore"  # the batch moved it: put back the previous timestamp


@dataclass(frozen=True, slots=True)
class RollbackStep:
    kind: StepKind
    source: str
    external_id: str
    restore_to: datetime | None


def plan_rollback(conn: db.Connection, receipt_id: int) -> list[RollbackStep]:
    """Return the steps that would undo ``receipt_id``, or refuse. Writes nothing."""
    receipt = conn.execute(
        "select applied_at from sync_receipt where id = %s", (receipt_id,)
    ).fetchone()
    if receipt is None:
        raise RollbackRefused(f"unknown receipt {receipt_id}")
    if receipt["applied_at"] is None:
        raise RollbackRefused(f"receipt {receipt_id} is a dry run and was never applied")
    already = conn.execute(
        "select 1 as found from sync_receipt_rollback where receipt_id = %s", (receipt_id,)
    ).fetchone()
    if already is not None:
        raise RollbackRefused(f"receipt {receipt_id} was already rolled back")

    items = conn.execute(
        "select source, external_id, action, source_updated_at, previous_applied_at "
        "from sync_receipt_item where receipt_id = %s order by ordinal",
        (receipt_id,),
    ).fetchall()
    steps: list[RollbackStep] = []
    for item in items:
        if item["action"] not in _TOUCHED:
            continue
        current = last_applied(conn, item["source"], item["external_id"])
        if current is None or current != item["source_updated_at"]:
            raise RollbackRefused(
                f"applied state of {item['source']}/{item['external_id']} "
                f"moved since batch {receipt_id}"
            )
        previous = item["previous_applied_at"]
        steps.append(
            RollbackStep(
                kind=StepKind.CLEAR if previous is None else StepKind.RESTORE,
                source=item["source"],
                external_id=item["external_id"],
                restore_to=previous,
            )
        )
    return steps


def rollback(conn: db.Connection, receipt_id: int, *, dry_run: bool = True) -> list[RollbackStep]:
    """Plan a rollback; with ``dry_run=False`` also apply it in this transaction.

    Restoring to an older timestamp is deliberate and bypasses the stale-write
    guard in ``sync_state.record_applied``: the batch being undone is the newer
    state, and this is the one path that is allowed to walk it back.
    """
    steps = plan_rollback(conn, receipt_id)
    if dry_run:
        return steps
    for step in steps:
        if step.restore_to is None:
            conn.execute(
                "delete from sync_applied_state where source = %s and external_id = %s",
                (step.source, step.external_id),
            )
        else:
            conn.execute(
                "update sync_applied_state set applied_at = %s "
                "where source = %s and external_id = %s",
                (step.restore_to, step.source, step.external_id),
            )
    conn.execute(
        "insert into sync_receipt_rollback (receipt_id, rolled_back_at) values (%s, %s)",
        (receipt_id, conn.tx_now()),
    )
    return steps
