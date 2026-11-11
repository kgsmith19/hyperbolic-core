"""Bills & Payments ledger row shaping acceptance tests (#595). Synthetic rows only."""

from datetime import date
from decimal import Decimal

import pytest

from domains.money.ledger_shape import LedgerHeaderError, shape_ledger

HEADER = ["ID", "Due date", "Amount", "Payment method", "Status", "Evidence"]


def _table(*rows: list[str]) -> list[list[str]]:
    return [HEADER, *rows]


def test_header_missing_any_required_column_is_refused() -> None:
    for missing in ("ID", "Due date", "Amount", "Payment method", "Status", "Evidence"):
        header = [column for column in HEADER if column != missing]
        with pytest.raises(LedgerHeaderError, match=missing.lower()):
            shape_ledger([header, ["x", "2026-11-20", "10", "manual", "unpaid", ""]])


def test_date_is_the_first_iso_date_in_an_annotated_cell() -> None:
    result = shape_ledger(
        _table(["bill-1", "due 2026-11-20 (was 2026-11-05)", "10", "manual", "unpaid", ""])
    )

    assert result.rows[0].row.due_date == date(2026, 11, 20)


def test_row_with_no_id_or_readable_date_is_rejected_with_a_reason() -> None:
    result = shape_ledger(
        _table(
            ["", "2026-11-20", "10", "manual", "unpaid", ""],
            ["bill-2", "sometime in November", "10", "manual", "unpaid", ""],
        )
    )

    assert result.rows == ()
    assert [r.reason for r in result.rejected] == ["no id", "no readable ISO date"]


def test_amounts_parse_as_decimal_and_bad_amounts_become_unknown() -> None:
    result = shape_ledger(
        _table(
            ["a", "2026-11-20", "1,234.50", "manual", "unpaid", ""],
            ["b", "2026-11-21", "", "manual", "unpaid", ""],
            ["c", "2026-11-22", "twelve", "manual", "unpaid", ""],
            ["d", "2026-11-23", "-5", "manual", "unpaid", ""],
        )
    )

    amounts = {shaped.row.bill_id: shaped.row.amount for shaped in result.rows}
    assert amounts == {"a": Decimal("1234.50"), "b": None, "c": None, "d": None}


def test_paid_requires_status_paid_and_a_named_evidence_source() -> None:
    result = shape_ledger(
        _table(
            ["paid-ok", "2026-11-20", "10", "manual", "paid", "bank-txn-9"],
            ["paid-no-evidence", "2026-11-21", "10", "manual", "paid", ""],
        )
    )

    statuses = {shaped.row.bill_id: shaped.row.payment_status for shaped in result.rows}
    assert statuses == {"paid-ok": "paid", "paid-no-evidence": "unknown"}


def test_failed_and_declined_read_as_failed_and_still_owed() -> None:
    result = shape_ledger(
        _table(
            ["declined", "2026-11-20", "10", "manual", "declined", ""],
            ["failed", "2026-11-21", "10", "manual", "failed", ""],
        )
    )

    statuses = {shaped.row.bill_id: shaped.row.payment_status for shaped in result.rows}
    assert statuses == {"declined": "unpaid", "failed": "unpaid"}


def test_autopay_reads_as_scheduled_and_sets_the_flag() -> None:
    result = shape_ledger(_table(["auto", "2026-11-20", "10", "AutoPay", "scheduled", ""]))

    assert result.rows[0].autopay_scheduled is True
    assert result.rows[0].row.payment_status == "unpaid"


def test_failed_autopay_is_its_own_forecast_status() -> None:
    result = shape_ledger(_table(["auto", "2026-11-20", "10", "AutoPay", "failed", ""]))

    assert result.rows[0].row.payment_status == "autopay_failed"
    assert result.rows[0].autopay_scheduled is True


def test_blank_status_fails_closed_to_unknown() -> None:
    result = shape_ledger(_table(["mystery", "2026-11-20", "10", "manual", "", ""]))

    assert result.rows[0].row.payment_status == "unknown"


def test_blank_rows_are_skipped_without_a_rejection() -> None:
    result = shape_ledger(
        _table(["", "", "", "", "", ""], ["keep", "2026-11-20", "1", "manual", "unpaid", ""])
    )

    assert [shaped.row.bill_id for shaped in result.rows] == ["keep"]
    assert result.rejected == ()


def test_empty_table_is_refused() -> None:
    with pytest.raises(LedgerHeaderError, match="empty"):
        shape_ledger([])
