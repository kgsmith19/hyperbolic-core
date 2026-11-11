"""Ledger-backed bill due-date forecast (#590).

Pure function over bill ledger rows for a date window. No I/O, no kernel read or
write, no network, no route, and no payment, transfer or dispute: it computes a
number and flags, and nothing else.

Rules this module holds to (from #590):

- Every row lands in exactly one bucket: ``obligation``, ``paid``, ``excluded``
  or ``out_of_window``. Buckets are counted, and the counts must sum to the row
  count.
- Unknown amounts and duplicate ``(bill_id, due_date)`` rows are flagged and
  excluded, never summed.
- Payment status comes only from the row's own ``payment_status`` plus its
  evidence. A balance never changes it. A ``paid`` row with no evidence is not
  treated as paid.
- Unpaid past-due rows are overdue obligations. A failed AutoPay is flagged and
  is still owed.
- A changed due date moves a row in or out of the window, because the window is
  evaluated on each row's own ``due_date``.
- Coverage is judged only against a fresh balance. Otherwise it stays unchecked.
"""

from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Literal

PaymentStatus = Literal["paid", "unpaid", "autopay_failed", "unknown"]
Bucket = Literal["obligation", "paid", "excluded", "out_of_window"]

FLAG_DUPLICATE = "duplicate"
FLAG_UNKNOWN_AMOUNT = "unknown_amount"
FLAG_PAID_WITHOUT_EVIDENCE = "paid_without_evidence"
FLAG_AUTOPAY_FAILED = "autopay_failed"
FLAG_STATUS_UNKNOWN = "status_unknown"
FLAG_STALE_BALANCE = "stale_balance"


@dataclass(frozen=True, slots=True)
class BillLedgerRow:
    """One ledger row, as the minimal contract approved for #590 defines it."""

    bill_id: str
    due_date: date
    amount: Decimal | None
    payment_status: PaymentStatus
    payment_evidence_id: str | None
    balance_fresh: bool
    excluded: bool


@dataclass(frozen=True, slots=True)
class ForecastRow:
    row: BillLedgerRow
    bucket: Bucket
    overdue: bool
    flags: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True, slots=True)
class Forecast:
    rows: tuple[ForecastRow, ...]
    bucket_counts: dict[str, int]
    total_committed: Decimal
    overdue_count: int
    coverage_checked: bool
    insufficient_coverage: bool


def _is_paid(row: BillLedgerRow) -> bool:
    return row.payment_status == "paid" and row.payment_evidence_id is not None


def forecast(
    rows: Iterable[BillLedgerRow],
    *,
    window_start: date,
    window_end: date,
    as_of: date,
    available_balance: Decimal | None = None,
) -> Forecast:
    """Forecast what is owed in ``[window_start, window_end]`` as of ``as_of``.

    ``available_balance`` is the operator-supplied liquid balance used for the
    coverage check. It is judged only when every in-window obligation's balance
    is fresh; otherwise coverage is reported as unchecked.
    """
    if window_start > window_end:
        raise ValueError("window_start must not be after window_end")
    batch = list(rows)
    for row in batch:
        if row.amount is not None and not isinstance(row.amount, Decimal):
            raise TypeError(f"{row.bill_id}: amount must be Decimal, never float")
        if row.amount is not None and row.amount < 0:
            raise ValueError(f"{row.bill_id}: amount must not be negative")
    if available_balance is not None and not isinstance(available_balance, Decimal):
        raise TypeError("available_balance must be Decimal, never float")

    keys = Counter((row.bill_id, row.due_date) for row in batch)
    out: list[ForecastRow] = []
    for row in batch:
        flags: set[str] = set()
        if keys[(row.bill_id, row.due_date)] > 1:
            flags.add(FLAG_DUPLICATE)
        if row.amount is None:
            flags.add(FLAG_UNKNOWN_AMOUNT)
        if row.payment_status == "paid" and row.payment_evidence_id is None:
            flags.add(FLAG_PAID_WITHOUT_EVIDENCE)
        if row.payment_status == "autopay_failed":
            flags.add(FLAG_AUTOPAY_FAILED)
        if row.payment_status == "unknown":
            flags.add(FLAG_STATUS_UNKNOWN)

        in_window = window_start <= row.due_date <= window_end
        paid = _is_paid(row)
        if not in_window:
            bucket: Bucket = "out_of_window"
        elif row.excluded or FLAG_DUPLICATE in flags:
            bucket = "excluded"
        elif paid:
            bucket = "paid"
        elif row.amount is None:
            bucket = "excluded"
        else:
            bucket = "obligation"

        overdue = (
            bucket == "obligation"
            and row.due_date < as_of
            and row.payment_status in ("unpaid", "autopay_failed")
        )
        if bucket == "obligation" and not row.balance_fresh:
            flags.add(FLAG_STALE_BALANCE)
        out.append(ForecastRow(row=row, bucket=bucket, overdue=overdue, flags=frozenset(flags)))

    result = tuple(out)
    counts: dict[str, int] = {"obligation": 0, "paid": 0, "excluded": 0, "out_of_window": 0}
    for item in result:
        counts[item.bucket] += 1
    assert sum(counts.values()) == len(result), "every row must land in exactly one bucket"

    obligations = [item for item in result if item.bucket == "obligation"]
    total = sum(
        (item.row.amount for item in obligations if item.row.amount is not None), Decimal("0")
    )

    coverage_checked = available_balance is not None and all(
        item.row.balance_fresh for item in obligations
    )
    insufficient = coverage_checked and available_balance is not None and total > available_balance

    return Forecast(
        rows=result,
        bucket_counts=counts,
        total_committed=total,
        overdue_count=sum(1 for item in result if item.overdue),
        coverage_checked=coverage_checked,
        insufficient_coverage=insufficient,
    )
