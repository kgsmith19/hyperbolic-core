"""Reconciliation receipts preserve what a sync batch planned without applying it (#588)."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest

from kernel import db
from kernel.external_identity import ExternalIdentity, IdentityCrosswalk
from kernel.sync_plan import PlanAction, PlannedChange, SourceRecord, plan_sync
from kernel.sync_receipts import summarize, write_receipt
from kernel.sync_state import applied_map, record_applied

T0 = datetime(2026, 11, 1, 9, 0, tzinfo=UTC)
T1 = T0 + timedelta(hours=1)
CANONICAL = UUID("00000000-0000-4000-8000-000000000042")


def _record(
    external_id: str, updated_at: datetime = T0, source: str = "google-tasks", title: str = "secret"
) -> SourceRecord:
    return SourceRecord(source=source, external_id=external_id, title=title, updated_at=updated_at)


def _crosswalk(*external_ids: str) -> IdentityCrosswalk:
    crosswalk = IdentityCrosswalk()
    for external_id in external_ids:
        crosswalk.register(ExternalIdentity("google-tasks", external_id, CANONICAL))
    return crosswalk


def test_summarize_counts_every_action_including_zeros() -> None:
    plan = [
        PlannedChange(PlanAction.CREATE, "google-tasks", "new", None, "new source identifier"),
        PlannedChange(PlanAction.CONFLICT, "google-tasks", "dup", None, "duplicate"),
    ]

    assert summarize(plan) == {
        PlanAction.CREATE: 1,
        PlanAction.UPDATE: 0,
        PlanAction.SKIP: 0,
        PlanAction.STALE: 0,
        PlanAction.CONFLICT: 1,
    }


def test_write_receipt_preserves_order_previous_state_and_excludes_titles() -> None:
    records = [
        _record("known", T1, title="payroll title"),
        _record("new", T0, title="private title"),
    ]
    crosswalk = _crosswalk("known")

    with db.connect() as conn:
        record_applied(conn, "google-tasks", "known", T0)
        plan = plan_sync(records, crosswalk, applied_map(conn))
        before = applied_map(conn)

        receipt = write_receipt(conn, records, plan)

        assert receipt.counts[PlanAction.UPDATE] == 1
        assert receipt.counts[PlanAction.CREATE] == 1
        assert applied_map(conn) == before
        assert conn.execute(
            "select counts from sync_receipt where id = %s", (receipt.id,)
        ).fetchone() == {
            "counts": {"create": 1, "update": 1, "skip": 0, "stale": 0, "conflict": 0}
        }
        assert {row["name"] for row in conn.execute("pragma table_info(sync_receipt_item)")} == {
            "receipt_id",
            "ordinal",
            "source",
            "external_id",
            "action",
            "source_updated_at",
            "previous_applied_at",
        }
        assert conn.execute(
            "select ordinal, source, external_id, action, source_updated_at, previous_applied_at "
            "from sync_receipt_item where receipt_id = %s order by ordinal",
            (receipt.id,),
        ).fetchall() == [
            {
                "ordinal": 0,
                "source": "google-tasks",
                "external_id": "known",
                "action": "update",
                "source_updated_at": T1,
                "previous_applied_at": T0,
            },
            {
                "ordinal": 1,
                "source": "google-tasks",
                "external_id": "new",
                "action": "create",
                "source_updated_at": T0,
                "previous_applied_at": None,
            },
        ]


def test_write_receipt_refuses_a_plan_for_different_records() -> None:
    records = [_record("actual")]
    mismatched_plan = [
        PlannedChange(PlanAction.CREATE, "google-tasks", "other", None, "new source identifier")
    ]

    with db.connect() as conn:
        before = conn.execute("select count(*) as count from sync_receipt").fetchone()
        with pytest.raises(ValueError, match="plan does not match records"):
            write_receipt(conn, records, mismatched_plan)
        assert conn.execute("select count(*) as count from sync_receipt").fetchone() == before


def test_replayed_applied_records_produce_an_all_skip_receipt() -> None:
    records = [_record("known", T0), _record("also-known", T1)]
    crosswalk = _crosswalk("known", "also-known")

    with db.connect() as conn:
        for record in records:
            record_applied(conn, record.source, record.external_id, record.updated_at)
        plan = plan_sync(records, crosswalk, applied_map(conn))

        receipt = write_receipt(conn, records, plan)

        assert [change.action for change in plan] == [PlanAction.SKIP, PlanAction.SKIP]
        assert receipt.counts == {
            PlanAction.CREATE: 0,
            PlanAction.UPDATE: 0,
            PlanAction.SKIP: 2,
            PlanAction.STALE: 0,
            PlanAction.CONFLICT: 0,
        }
