"""Bills & Payments ledger job: shape an exported ledger and receipt the header mapping (#613).

Usage: ``python -m domains.money.ledger_job <ledger.csv>``. The CSV is the ledger sheet
exported with its header row first (a live Sheets fetch can feed the same function).

Every run records one execution receipt through ``domains.ops.receipts.run_job``:

- ok: which header text each required column resolved to, plus counts of rows shaped
  and rejected. Header names and counts only, never a ledger value.
- failed: a refused header names the required column and the problem (missing or
  duplicated), never the raw header text.

Shaping is ``ledger_shape.shape_ledger`` (pure). Nothing is written to the ledger and
nothing is paid, scheduled or disputed here.
"""

import csv
import io
import sys
from pathlib import Path

from domains.money.common import money_context
from domains.money.ledger_shape import LedgerHeaderError, ShapeResult, shape_ledger
from domains.ops.receipts import STATUS_FAILED, STATUS_OK, JobResult, run_job
from kernel.access import AccessContext

METHOD = "domains.money.ledger_job"


def receipt_summary(result: ShapeResult) -> str:
    mapping = ", ".join(f"{column}={header!r}" for column, header in result.header_map)
    return f"header map: {mapping}; rows shaped={len(result.rows)} rejected={len(result.rejected)}"


def refusal_summary(error: LedgerHeaderError) -> str:
    if error.problem == "empty" or not error.column:
        return "header refused: the ledger table is empty"
    return f"header refused: column {error.column!r} {error.problem}"


def _job(ctx: AccessContext, path: Path) -> JobResult:
    try:
        text = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError) as exc:
        return JobResult(status=STATUS_FAILED, summary=f"could not read file: {type(exc).__name__}")
    table = [row for row in csv.reader(io.StringIO(text))]
    try:
        result = shape_ledger(table)
    except LedgerHeaderError as exc:
        summary = refusal_summary(exc)
        print(f"ledger_job: FAILED - {summary}", file=sys.stderr)
        return JobResult(status=STATUS_FAILED, summary=summary)
    summary = receipt_summary(result)
    print(summary)
    return JobResult(status=STATUS_OK, summary=summary)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        print("usage: python -m domains.money.ledger_job <ledger.csv>", file=sys.stderr)
        return 2
    path = Path(args[0])
    return run_job(money_context(), METHOD, lambda ctx: _job(ctx, path))


if __name__ == "__main__":
    raise SystemExit(main())
