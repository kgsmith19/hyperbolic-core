"""Rollback of an applied source-sync batch from its receipt (#589)."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest

from kernel import db
from kernel.external_identity import ExternalIdentity, IdentityCrosswalk
from kernel.sync_plan import SourceRecord, plan_sync
from kernel.sync_receipts import write_receipt
from kernel.sync_rollback import RollbackRefused, StepKind, plan_rollback, rollback
from kernel.sync_state import applied_map, last_applied, record_applied

T0 = datetime(2026, 11, 1, 9, 0, tzinfo=UTC)
T1 = T0 + timedelta(hours=1)
T2 = T0 + timedelta(hours=2)
SOURCE = "rb-tasks"
CANONICAL = UUID("00000000-0000-4000-8000-000000000089")


def _record(external_id: str, updated_at: datetime, title: str = "t") -> SourceRecord:
    return SourceRecord(source=SOURCE, external_id=external_id, title=title, updated_at=updated_at)


def _batch(conn: db.Connection, records: list[SourceRecord], known: dict[str, datetime]):
    """Plan and persist a receipt for ``records``; ``known`` ids exist in the crosswalk."""
    crosswalk = IdentityCrosswalk()
    for external_id in known:
        crosswalk.register(ExternalIdentity(SOURCE, external_id, CANONICAL))
    plan = plan_sync(records, crosswalk, applied_map(conn))
    return write_receipt(conn, records, plan)


def _apply(conn: db.Connection, receipt_id: int, records: list[SourceRecord], plan_actions) -> None:
    """Simulate the owner-approved apply step: mark the receipt and write applied state."""
    for record, action in zip(records, plan_actions, strict=True):
        if action in ("create", "update"):
            record_applied(conn, record.source, record.external_id, record.updated_at)
    conn.execute(
        "update sync_receipt set applied_at = %s where id = %s", (conn.tx_now(), receipt_id)
    )


def test_dry_run_returns_steps_and_writes_nothing() -> None:
    with db.connect() as conn:
        records = [_record("dr-known", T1), _record("dr-new", T0)]
        record_applied(conn, SOURCE, "dr-known", T0)
        receipt = _batch(conn, records, known={"dr-known": T0})
        _apply(conn, receipt.id, records, ["update", "create"])
        before = applied_map(conn)

        steps = rollback(conn, receipt.id)

        assert {(s.kind, s.external_id) for s in steps} == {
            (StepKind.RESTORE, "dr-known"),
            (StepKind.CLEAR, "dr-new"),
        }
        assert applied_map(conn) == before
        assert conn.execute(
            "select count(*) as n from sync_receipt_rollback where receipt_id = %s", (receipt.id,)
        ).fetchone() == {"n": 0}


def test_rollback_restores_updates_clears_creates_and_leaves_skips_alone() -> None:
    with db.connect() as conn:
        records = [
            _record("rb-update", T1),  # known, previously applied at T0 -> restore to T0
            _record("rb-create", T0),  # new -> clear
            _record("rb-skip", T0),  # already applied at T0 -> skip, untouched
        ]
        record_applied(conn, SOURCE, "rb-update", T0)
        record_applied(conn, SOURCE, "rb-skip", T0)
        receipt = _batch(conn, records, known={"rb-update": T0, "rb-skip": T0})
        plan_actions = [
            row["action"]
            for row in conn.execute(
                "select action from sync_receipt_item where receipt_id = %s order by ordinal",
                (receipt.id,),
            ).fetchall()
        ]
        _apply(conn, receipt.id, records, plan_actions)

        rollback(conn, receipt.id, dry_run=False)

        assert last_applied(conn, SOURCE, "rb-update") == T0
        assert last_applied(conn, SOURCE, "rb-create") is None
        assert last_applied(conn, SOURCE, "rb-skip") == T0
        assert conn.execute(
            "select rolled_back_at is not null as done from sync_receipt_rollback "
            "where receipt_id = %s",
            (receipt.id,),
        ).fetchone() == {"done": 1}


def test_refuses_a_dry_run_receipt() -> None:
    with db.connect() as conn:
        receipt = _batch(conn, [_record("never-applied", T0)], known={})
        with pytest.raises(RollbackRefused, match="dry run"):
            plan_rollback(conn, receipt.id)


def test_refuses_an_unknown_receipt() -> None:
    with db.connect() as conn, pytest.raises(RollbackRefused, match="unknown receipt"):
        plan_rollback(conn, 987654)


def test_refuses_a_second_rollback() -> None:
    with db.connect() as conn:
        records = [_record("twice", T0)]
        receipt = _batch(conn, records, known={})
        _apply(conn, receipt.id, records, ["create"])
        rollback(conn, receipt.id, dry_run=False)
        with pytest.raises(RollbackRefused, match="already rolled back"):
            plan_rollback(conn, receipt.id)


def test_refuses_when_applied_state_moved_and_writes_nothing() -> None:
    with db.connect() as conn:
        records = [_record("moved-create", T0), _record("moved-update", T1)]
        record_applied(conn, SOURCE, "moved-update", T0)
        receipt = _batch(conn, records, known={"moved-update": T0})
        _apply(conn, receipt.id, records, ["create", "update"])
        # Someone applies a newer state for the update item after the batch.
        record_applied(conn, SOURCE, "moved-update", T2)
        before = applied_map(conn)

        with pytest.raises(RollbackRefused, match="moved since batch"):
            rollback(conn, receipt.id, dry_run=False)

        assert applied_map(conn) == before
        assert last_applied(conn, SOURCE, "moved-create") == T0
        assert conn.execute(
            "select count(*) as n from sync_receipt_rollback where receipt_id = %s", (receipt.id,)
        ).fetchone() == {"n": 0}
