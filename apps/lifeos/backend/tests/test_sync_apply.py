"""Apply a planned source-sync batch from its receipt (#572)."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest

from kernel import db
from kernel.external_identity import ExternalIdentity, IdentityCrosswalk
from kernel.sync_apply import ApplyRefused, apply, plan_apply
from kernel.sync_plan import PlanAction, SourceRecord, plan_sync
from kernel.sync_receipts import write_receipt
from kernel.sync_rollback import rollback
from kernel.sync_state import applied_map, last_applied, record_applied

T0 = datetime(2026, 11, 1, 9, 0, tzinfo=UTC)
T1 = T0 + timedelta(hours=1)
T2 = T0 + timedelta(hours=2)
SOURCE = "ap-tasks"
CANONICAL = UUID("00000000-0000-4000-8000-000000000572")


def _record(external_id: str, updated_at: datetime) -> SourceRecord:
    return SourceRecord(source=SOURCE, external_id=external_id, title="t", updated_at=updated_at)


def _crosswalk(*known: str) -> IdentityCrosswalk:
    crosswalk = IdentityCrosswalk()
    for external_id in known:
        crosswalk.register(ExternalIdentity(SOURCE, external_id, CANONICAL))
    return crosswalk


def _batch(conn: db.Connection, records: list[SourceRecord], *known: str) -> int:
    plan = plan_sync(records, _crosswalk(*known), applied_map(conn))
    return write_receipt(conn, records, plan).id


def _applied_flag(conn: db.Connection, receipt_id: int) -> object:
    row = conn.execute(
        "select applied_at from sync_receipt where id = %s", (receipt_id,)
    ).fetchone()
    assert row is not None
    return row["applied_at"]


def test_dry_run_returns_steps_and_writes_nothing() -> None:
    with db.connect() as conn:
        record_applied(conn, SOURCE, "dry-known", T0)
        records = [_record("dry-known", T1), _record("dry-new", T0)]
        receipt = _batch(conn, records, "dry-known")
        before = applied_map(conn)

        steps = apply(conn, receipt)

        assert {(s.external_id, s.applied_at, s.previous) for s in steps} == {
            ("dry-known", T1, T0),
            ("dry-new", T0, None),
        }
        assert applied_map(conn) == before
        assert _applied_flag(conn, receipt) is None


def test_apply_writes_state_marks_the_receipt_and_a_second_run_is_all_skip() -> None:
    with db.connect() as conn:
        record_applied(conn, SOURCE, "run-known", T0)
        records = [_record("run-known", T1), _record("run-new", T0), _record("run-same", T0)]
        record_applied(conn, SOURCE, "run-same", T0)
        receipt = _batch(conn, records, "run-known", "run-same")

        apply(conn, receipt, dry_run=False)

        assert last_applied(conn, SOURCE, "run-known") == T1
        assert last_applied(conn, SOURCE, "run-new") == T0
        assert _applied_flag(conn, receipt) is not None
        # Re-planning the same source records changes nothing: zero duplicates.
        crosswalk = _crosswalk("run-known", "run-same", "run-new")
        second = plan_sync(records, crosswalk, applied_map(conn))
        assert {change.action for change in second} == {PlanAction.SKIP}


def test_a_receipt_is_applied_at_most_once() -> None:
    with db.connect() as conn:
        receipt = _batch(conn, [_record("once", T0)])
        apply(conn, receipt, dry_run=False)
        with pytest.raises(ApplyRefused, match="already applied"):
            apply(conn, receipt, dry_run=False)


def test_refuses_when_applied_state_moved_since_the_plan_and_writes_nothing() -> None:
    with db.connect() as conn:
        record_applied(conn, SOURCE, "moved", T0)
        records = [_record("moved", T1), _record("moved-new", T0)]
        receipt = _batch(conn, records, "moved")
        record_applied(conn, SOURCE, "moved", T2)  # someone applied a newer state since
        before = applied_map(conn)

        with pytest.raises(ApplyRefused, match="moved since batch"):
            apply(conn, receipt, dry_run=False)

        assert applied_map(conn) == before
        assert last_applied(conn, SOURCE, "moved-new") is None  # no partial write
        assert _applied_flag(conn, receipt) is None


def test_refuses_unknown_and_rolled_back_receipts_and_leaves_skips_alone() -> None:
    with db.connect() as conn:
        with pytest.raises(ApplyRefused, match="unknown receipt"):
            plan_apply(conn, 999_999)
        record_applied(conn, SOURCE, "rb", T0)
        receipt = _batch(conn, [_record("rb", T0)], "rb")  # skip: nothing to apply
        assert apply(conn, receipt) == []
        receipt = _batch(conn, [_record("rb2", T0)])
        apply(conn, receipt, dry_run=False)
        rollback(conn, receipt, dry_run=False)
        conn.execute("update sync_receipt set applied_at = null where id = %s", (receipt,))
        with pytest.raises(ApplyRefused, match="rolled back"):
            apply(conn, receipt, dry_run=False)
