"""Bank CSV transaction import (roadmap C0).

Operator-run over a local file, not scheduled — the
`domains.intentions.import_priorities` / `domains.bills.extract` precedent:
``python -m domains.money.csv_import <path> [account_label]``. The file
itself never enters the repo; only its bytes' sha256 is receipted.

Documented minimum columns (header row required, case-insensitive): `date`
(ISO `YYYY-MM-DD` or `MM/DD/YYYY`), `amount` (signed decimal; accounting
`(123.45)` negative form accepted), `description`. Optional: `currency`
(defaults `USD`). A row missing a required field, an unparseable date, or an
unparseable amount is dropped and counted — never guessed at (the bills
`extract._amount`/`_date` precedent).

Same two-layer idempotency as `domains.money.simplefin_ingest`: a
`money_source_receipt` short-circuits an unchanged file (by sha256), and
inside a changed file each row is compared against its stored `transaction`
(by `transaction_key`) before writing — so reimporting an overlapping
statement date range is a no-op for every transaction already on record.
"""

import csv
import io
import sys
from dataclasses import dataclass
from datetime import UTC, date, datetime
from hashlib import sha256
from pathlib import Path

from domains.money.common import (
    ParsedTransaction,
    WriteReport,
    account_key,
    money_context,
    write_transactions,
)
from domains.ops.receipts import STATUS_FAILED, STATUS_OK, JobResult, run_job
from kernel.access import AccessContext

SOURCE = "csv"
METHOD = "domains.money.csv_import"
DEFAULT_CURRENCY = "USD"
MAX_FILE_BYTES = 8 * 1024 * 1024  # untrusted input bound

_DATE_FORMATS = ("%Y-%m-%d", "%m/%d/%Y")


@dataclass
class ImportReport:
    write: WriteReport
    rows_read: int
    rows_dropped: int

    def line(self) -> str:
        return (
            f"{self.write.line()} rows_read={self.rows_read} rows_dropped={self.rows_dropped}"
        )


def _parse_date(raw: str) -> date | None:
    value = raw.strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    return None


def _parse_amount(raw: str) -> float | None:
    value = raw.strip().replace(",", "").replace("$", "")
    if not value:
        return None
    negative = value.startswith("(") and value.endswith(")")
    if negative:
        value = value[1:-1]
    try:
        amount = float(value)
    except ValueError:
        return None
    return -amount if negative else amount


def _header_index(header: list[str], name: str) -> int | None:
    lowered = [h.strip().lower() for h in header]
    return lowered.index(name) if name in lowered else None


def parse_rows(content: str, acct_key: str) -> tuple[list[ParsedTransaction], int, int]:
    """CSV text -> (parsed transactions, rows read, rows dropped). Every row
    that fails any check is dropped and counted, never guessed at."""
    reader = csv.reader(io.StringIO(content))
    try:
        header = next(reader)
    except StopIteration:
        return [], 0, 0

    date_i = _header_index(header, "date")
    amount_i = _header_index(header, "amount")
    desc_i = _header_index(header, "description")
    currency_i = _header_index(header, "currency")
    if date_i is None or amount_i is None or desc_i is None:
        raise ValueError("CSV header must include date, amount, description")

    transactions: list[ParsedTransaction] = []
    rows_read = 0
    rows_dropped = 0
    for row in reader:
        if not row or all(not cell.strip() for cell in row):
            continue  # blank line
        rows_read += 1
        if len(row) <= max(date_i, amount_i, desc_i):
            rows_dropped += 1
            continue
        posted_date = _parse_date(row[date_i])
        amount = _parse_amount(row[amount_i])
        description = row[desc_i].strip()
        if posted_date is None or amount is None or not description:
            rows_dropped += 1
            continue
        currency = None
        if currency_i is not None and currency_i < len(row):
            candidate = row[currency_i].strip().upper()
            currency = candidate if len(candidate) == 3 else None
        transactions.append(
            ParsedTransaction(
                account_key=acct_key,
                posted_date=posted_date,
                amount=amount,
                description=description,
                source=SOURCE,
                currency=currency or DEFAULT_CURRENCY,
            )
        )
    return transactions, rows_read, rows_dropped


def import_csv(
    ctx: AccessContext,
    content: bytes,
    account_label: str,
    fetched_at: datetime | None = None,
) -> ImportReport:
    """Import one CSV file's bytes for one operator-labelled account. Pure
    kernel-service calls; no raw SQL. Idempotent by construction."""
    if len(content) > MAX_FILE_BYTES:
        raise ValueError(f"file exceeds {MAX_FILE_BYTES} byte bound")
    fetched_at = fetched_at or datetime.now(UTC)
    acct_key = account_key(SOURCE, account_label)
    payload_sha = sha256(content).hexdigest()
    text = content.decode("utf-8-sig", errors="replace")
    transactions, rows_read, rows_dropped = parse_rows(text, acct_key)

    if transactions:
        window_start = min(t.posted_date for t in transactions)
        window_end = max(t.posted_date for t in transactions)
    else:
        window_start = window_end = fetched_at.date()

    write = write_transactions(
        ctx,
        METHOD,
        SOURCE,
        payload_sha,
        window_start,
        window_end,
        {acct_key: (account_label, None)},
        transactions,
        fetched_at,
    )
    return ImportReport(write=write, rows_read=rows_read, rows_dropped=rows_dropped)


def _job(ctx: AccessContext, path: Path, account_label: str) -> JobResult:
    try:
        content = path.read_bytes()
    except OSError as exc:
        # Class name only: the OS message can echo the full path, which is a
        # local operator detail, not something a receipt should retain.
        print(f"csv_import: FAILED - {type(exc).__name__}", file=sys.stderr)
        return JobResult(status=STATUS_FAILED, summary=f"could not read file: {type(exc).__name__}")

    try:
        report = import_csv(ctx, content, account_label)
    except ValueError as exc:
        print(f"csv_import: FAILED - {exc}", file=sys.stderr)
        return JobResult(status=STATUS_FAILED, summary=f"import failed: {exc}")

    print(report.line())
    produced = (
        []
        if report.write.unchanged or report.write.receipt_id is None
        else [report.write.receipt_id]
    )
    return JobResult(status=STATUS_OK, summary=report.line(), produced=produced)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        print("usage: python -m domains.money.csv_import <path> [account_label]", file=sys.stderr)
        return 2
    path = Path(args[0])
    account_label = args[1] if len(args) > 1 else path.stem
    return run_job(money_context(), METHOD, lambda ctx: _job(ctx, path, account_label))


if __name__ == "__main__":
    raise SystemExit(main())
