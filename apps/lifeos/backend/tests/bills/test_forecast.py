"""Bill due-date forecast acceptance tests (#590)."""

from datetime import date
from decimal import Decimal

import pytest

from domains.bills.forecast import (
    FLAG_AUTOPAY_FAILED,
    FLAG_DUPLICATE,
    FLAG_PAID_WITHOUT_EVIDENCE,
    FLAG_STALE_BALANCE,
    FLAG_UNKNOWN_AMOUNT,
    BillLedgerRow,
    forecast,
)

START = date(2026, 11, 1)
END = date(2026, 11, 30)
AS_OF = date(2026, 11, 15)


def _row(
    bill_id: str = "electric",
    due: date = date(2026, 11, 20),
    amount: Decimal | None = Decimal("100.00"),
    status: str = "unpaid",
    evidence: str | None = None,
    fresh: bool = True,
    excluded: bool = False,
) -> BillLedgerRow:
    return BillLedgerRow(
        bill_id=bill_id,
        due_date=due,
        amount=amount,
        payment_status=status,  # type: ignore[arg-type]
        payment_evidence_id=evidence,
        balance_fresh=fresh,
        excluded=excluded,
    )


def _run(rows: list[BillLedgerRow], **kwargs):
    return forecast(rows, window_start=START, window_end=END, as_of=AS_OF, **kwargs)


def test_every_row_lands_in_exactly_one_bucket_and_counts_reconcile() -> None:
    rows = [
        _row("a"),
        _row("b", status="paid", evidence="ev-1"),
        _row("c", excluded=True),
        _row("d", due=date(2026, 12, 5)),
    ]

    result = _run(rows)

    assert sum(result.bucket_counts.values()) == len(rows)
    assert result.bucket_counts == {"obligation": 1, "paid": 1, "excluded": 1, "out_of_window": 1}


def test_unknown_amount_is_excluded_and_flagged_never_summed() -> None:
    result = _run([_row("mystery", amount=None), _row("known", amount=Decimal("40.25"))])

    mystery = next(item for item in result.rows if item.row.bill_id == "mystery")
    assert mystery.bucket == "excluded"
    assert FLAG_UNKNOWN_AMOUNT in mystery.flags
    assert result.total_committed == Decimal("40.25")


def test_duplicate_bill_and_due_date_are_both_excluded_and_flagged() -> None:
    result = _run([_row("dup"), _row("dup")])

    assert all(item.bucket == "excluded" for item in result.rows)
    assert all(FLAG_DUPLICATE in item.flags for item in result.rows)
    assert result.total_committed == Decimal("0")


def test_payment_status_comes_only_from_evidence_not_balance() -> None:
    paid_no_evidence = _run([_row("p", status="paid", evidence=None)])
    paid_with_evidence = _run([_row("p", status="paid", evidence="ev-9")])
    # Balance is not an input to status, so a large available balance cannot make it paid.
    rich = _run([_row("p", status="unpaid")], available_balance=Decimal("99999"))

    assert paid_no_evidence.rows[0].bucket == "obligation"
    assert FLAG_PAID_WITHOUT_EVIDENCE in paid_no_evidence.rows[0].flags
    assert paid_with_evidence.rows[0].bucket == "paid"
    assert rich.rows[0].bucket == "obligation"


def test_unpaid_past_due_is_overdue_and_still_owed() -> None:
    result = _run([_row("late", due=date(2026, 11, 10), status="unpaid")])

    item = result.rows[0]
    assert item.overdue is True
    assert item.bucket == "obligation"
    assert result.total_committed == Decimal("100.00")
    assert result.overdue_count == 1


def test_failed_autopay_is_flagged_and_still_owed() -> None:
    result = _run([_row("auto", due=date(2026, 11, 10), status="autopay_failed")])

    item = result.rows[0]
    assert FLAG_AUTOPAY_FAILED in item.flags
    assert item.overdue is True
    assert result.total_committed == Decimal("100.00")


def test_changed_due_date_moves_a_bill_into_or_out_of_the_window() -> None:
    inside = _run([_row("moved", due=date(2026, 11, 20))])
    outside = _run([_row("moved", due=date(2026, 12, 20))])

    assert inside.rows[0].bucket == "obligation"
    assert outside.rows[0].bucket == "out_of_window"
    assert outside.total_committed == Decimal("0")


def test_coverage_is_checked_against_a_fresh_balance_and_flags_shortfall() -> None:
    result = _run([_row("big", amount=Decimal("500.00"))], available_balance=Decimal("300.00"))

    assert result.coverage_checked is True
    assert result.insufficient_coverage is True


def test_stale_balance_leaves_coverage_unchecked() -> None:
    result = _run(
        [_row("big", amount=Decimal("500.00"), fresh=False)], available_balance=Decimal("300.00")
    )

    assert result.coverage_checked is False
    assert result.insufficient_coverage is False
    assert FLAG_STALE_BALANCE in result.rows[0].flags


def test_missing_balance_leaves_coverage_unchecked() -> None:
    result = _run([_row("any")])

    assert result.coverage_checked is False
    assert result.insufficient_coverage is False


def test_money_must_be_decimal_never_float() -> None:
    with pytest.raises(TypeError, match="Decimal"):
        _run([_row("f", amount=12.5)])  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="Decimal"):
        _run([_row("ok")], available_balance=300.0)  # type: ignore[arg-type]


def test_negative_amount_is_refused() -> None:
    with pytest.raises(ValueError, match="negative"):
        _run([_row("neg", amount=Decimal("-1"))])


def test_inverted_window_is_refused() -> None:
    with pytest.raises(ValueError, match="window_start"):
        forecast([], window_start=END, window_end=START, as_of=AS_OF)
