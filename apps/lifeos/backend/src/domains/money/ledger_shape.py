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
- Header columns may be named by an exact alias (case and surrounding or repeated
  whitespace ignored), never by fuzzy match. A column matched by two header cells
  is ambiguous and refused. The resolved column-to-header mapping is returned on
  the result so the caller can record which header text was used, never a value.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation

from domains.bills.forecast import BillLedgerRow, PaymentStatus

REQUIRED_COLUMNS = ("id", "due date", "amount", "payment method", "status", "evidence")
# Exact, reviewed aliases per required column. Fuzzy matching is deliberately absent:
# a column the owner did not name in this list is not guessed at.
ALIASES: dict[str, tuple[str, ...]] = {
    "id": ("id", "bill id", "bill"),
    "due date": ("due date", "due", "date due", "due on"),
    "amount": ("amount", "amount due", "total"),
    "payment method": ("payment method", "method", "pay method"),
    "status": ("status", "payment status"),
    "evidence": ("evidence", "proof", "evidence id"),
}
_ISO_DATE = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")


class LedgerHeaderError(ValueError):
    """The ledger header is missing a required column; nothing is shaped.

    ``column`` names the required column at fault (empty for an empty table) and
    ``problem`` is ``missing``, ``duplicated`` or ``empty``: enough for a receipt, with
    no header or ledger text."""

    def __init__(self, message: str, column: str = "", problem: str = "empty") -> None:
        super().__init__(message)
        self.column = column
        self.problem = problem


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
    # (required column, header text it matched), in REQUIRED_COLUMNS order.
    header_map: tuple[tuple[str, str], ...] = ()


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


def _normalize(cell: str) -> str:
    return " ".join(cell.split()).lower()


def _header_index(header: Sequence[str]) -> dict[str, int]:
    normalized = [_normalize(cell) for cell in header]
    index: dict[str, int] = {}
    for column in REQUIRED_COLUMNS:
        matches = [i for i, cell in enumerate(normalized) if cell in ALIASES[column]]
        if not matches:
            raise LedgerHeaderError(
                f"ledger header is missing the {column!r} column", column, "missing"
            )
        if len(matches) > 1:
            raise LedgerHeaderError(
                f"ledger header names the {column!r} column more than once", column, "duplicated"
            )
        index[column] = matches[0]
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
    header_map = tuple((column, _normalize(table[0][index[column]])) for column in REQUIRED_COLUMNS)

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

    return ShapeResult(rows=tuple(shaped), rejected=tuple(rejected), header_map=header_map)
