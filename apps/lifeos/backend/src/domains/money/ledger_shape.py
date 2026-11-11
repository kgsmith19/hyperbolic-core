"""Bills & Payments ledger row shaping for the forecast (#595).

Maps rows from the Bills & Payments ledger (header plus data rows, fetched by the
caller) onto the forecast's ``BillLedgerRow`` input, failing closed per row.

Pure: no network, no Sheets client, no write, no schedule. Fetching the sheet
and the action launcher with its receipt stay under #574.

Rules (from #595):

- The header must carry the id, date, amount, payment method, status and
  evidence columns. A header missing any of them is refused.
- The date is the first ISO ``YYYY-MM-DD`` in the date cell. A row with no id or
  no readable date is rejected with a reason.
- Amounts parse as ``Decimal``. Blank, unreadable or negative amounts become
  unknown (``None``), never zero.
- Paid only when the status says paid AND a verified evidence source is named.
  Failed and declined read as unpaid (still owed). AutoPay reads as scheduled:
  it is owed, and the row carries an ``autopay_scheduled`` flag.
- Blank rows are skipped.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation

from domains.bills.forecast import BillLedgerRow, PaymentStatus

REQUIRED_COLUMNS = ("id", "due date", "amount", "payment method", "status", "evidence")
_ISO_DATE = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")


class LedgerHeaderError(ValueError):
    """The ledger header is missing a required column; nothing is shaped."""


@dataclass(frozen=True, slots=True)
class ShapedRow:
    row: BillLedgerRow
    autopay_scheduled: bool


@dataclass(frozen=True, slots=True)
class Rejected:
    line: int
    reason: str


@dataclass(frozen=True, slots=True)
class ShapeResult:
    rows: tuple[ShapedRow, ...]
    rejected: tuple[Rejected, ...]


def _parse_amount(cell: str) -> Decimal | None:
    text = cell.strip().replace(",", "").replace("$", "")
    if not text:
        return None
    try:
        value = Decimal(text)
    except InvalidOperation:
        return None
    if not value.is_finite() or value < 0:
        return None
    return value


def _parse_date(cell: str) -> date | None:
    match = _ISO_DATE.search(cell)
    if match is None:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def _header_index(header: Sequence[str]) -> dict[str, int]:
    normalized = [cell.strip().lower() for cell in header]
    index: dict[str, int] = {}
    for column in REQUIRED_COLUMNS:
        if column not in normalized:
            raise LedgerHeaderError(f"ledger header is missing the {column!r} column")
        index[column] = normalized.index(column)
    return index


def _status_for(status_text: str, method: str, evidence: str) -> PaymentStatus:
    """Status from the ledger's own words. Blank or unrecognised reads as unknown."""
    status = status_text.strip().lower()
    if status == "paid":
        return "paid" if evidence else "unknown"
    if status == "failed" and method.lower() == "autopay":
        return "autopay_failed"
    if status in ("failed", "declined", "unpaid", "scheduled", "autopay"):
        return "unpaid"
    return "unknown"


def _cell(cells: Sequence[str], index: dict[str, int], column: str) -> str:
    position = index[column]
    return cells[position] if position < len(cells) else ""


def shape_ledger(table: Sequence[Sequence[str]]) -> ShapeResult:
    """Shape a ledger table (header first). Refuses a bad header; rejects bad rows."""
    if not table:
        raise LedgerHeaderError("ledger table is empty")
    index = _header_index(table[0])

    shaped: list[ShapedRow] = []
    rejected: list[Rejected] = []
    for offset, cells in enumerate(table[1:], start=2):
        if all(not cell.strip() for cell in cells):
            continue

        bill_id = _cell(cells, index, "id").strip()
        if not bill_id:
            rejected.append(Rejected(offset, "no id"))
            continue
        due = _parse_date(_cell(cells, index, "due date"))
        if due is None:
            rejected.append(Rejected(offset, "no readable ISO date"))
            continue

        evidence = _cell(cells, index, "evidence").strip()
        method = _cell(cells, index, "payment method").strip()
        status = _status_for(_cell(cells, index, "status"), method, evidence)
        autopay = method.lower() == "autopay"

        shaped.append(
            ShapedRow(
                row=BillLedgerRow(
                    bill_id=bill_id,
                    due_date=due,
                    amount=_parse_amount(_cell(cells, index, "amount")),
                    payment_status=status,
                    payment_evidence_id=evidence or None,
                    balance_fresh=False,
                    excluded=False,
                ),
                autopay_scheduled=autopay,
            )
        )

    return ShapeResult(rows=tuple(shaped), rejected=tuple(rejected))
