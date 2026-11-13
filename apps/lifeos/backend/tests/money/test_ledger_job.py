"""Ledger job receipts (#613): header mapping and counts only; refusals name the column."""

from pathlib import Path

import pytest

from domains.money.common import money_context
from domains.money.ledger_job import METHOD, main
from domains.money.types import define_money_types
from kernel.access import AccessContext
from kernel.services import find

HEADER = "Bill ID,Due,Amount Due,Method,Payment Status,Proof\n"
ROWS = (
    "elec-11,2026-11-20,96.67,AutoPay,scheduled,\n"
    "card-11,2026-12-01,412.30,manual,paid,stmt-2026-11\n"
    ",2026-12-02,10.00,manual,unpaid,\n"  # rejected: no id
)


@pytest.fixture(scope="module")
def money_ctx(clean_database: None) -> AccessContext:
    ctx = money_context()
    define_money_types(ctx)
    return ctx


def last_receipt(ctx: AccessContext) -> dict[str, object]:
    receipts = find(ctx, type_name="execution_receipt", filters={"job": METHOD})
    assert receipts
    return dict(receipts[-1].attributes)


def test_ok_receipt_holds_the_header_mapping_and_counts_but_no_ledger_value(
    tmp_path: Path, money_ctx: AccessContext
) -> None:
    path = tmp_path / "ledger.csv"
    path.write_text(HEADER + ROWS)
    assert main([str(path)]) == 0
    receipt = last_receipt(money_ctx)
    summary = str(receipt["summary"])
    assert receipt["status"] == "ok"
    assert "id='bill id'" in summary and "amount='amount due'" in summary
    assert "rows shaped=2 rejected=1" in summary
    for value in ("elec-11", "96.67", "412.30", "stmt-2026-11", "2026-11-20"):
        assert value not in summary


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("Bill ID,Due,Method,Payment Status,Proof\n", "column 'amount' missing"),
        ("Bill ID,Due,Total,Amount Due,Method,Status,Proof\n", "column 'amount' duplicated"),
    ],
)
def test_a_refused_header_records_a_failed_receipt_naming_only_the_column(
    tmp_path: Path, money_ctx: AccessContext, header: str, expected: str
) -> None:
    path = tmp_path / "bad.csv"
    path.write_text(header + "x,2026-11-20,1,manual,paid,proof\n")
    assert main([str(path)]) == 1
    receipt = last_receipt(money_ctx)
    assert receipt["status"] == "failed"
    assert receipt["summary"] == f"header refused: {expected}"
    assert "Amount Due" not in str(receipt["summary"])  # never the raw header text


def test_an_empty_or_missing_file_fails_with_a_receipt(
    tmp_path: Path, money_ctx: AccessContext
) -> None:
    empty = tmp_path / "empty.csv"
    empty.write_text("")
    assert main([str(empty)]) == 1
    assert last_receipt(money_ctx)["summary"] == "header refused: the ledger table is empty"
    assert main([str(tmp_path / "nope.csv")]) == 1
    assert last_receipt(money_ctx)["summary"] == "could not read file: FileNotFoundError"
    assert main([]) == 2
