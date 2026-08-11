"""Bank CSV import tests (roadmap C0).

`parse_rows` is pure and unit-tested directly; `import_csv` and the CLI
entry point (`main`) are integration-tested against the real kernel,
mirroring `domains.money.simplefin_ingest`'s idempotency and
malformed-row-handling proofs.
"""

from datetime import date
from pathlib import Path

import pytest

from domains.money.common import DERIVED_FROM, account_key
from domains.money.csv_import import (
    METHOD,
    import_csv,
    main,
    money_context,
    parse_rows,
)
from domains.money.types import define_money_types
from kernel.access import AccessContext
from kernel.services import find, forget, get_entity, redacted_fields

AK = account_key("csv", "checking")

CSV_BASIC = (
    "date,amount,description\n"
    "2026-08-01,-12.34,AMAZON.COM\n"
    "2026-08-02,1500.00,PAYCHECK DEPOSIT\n"
)


# ---------------------------------------------------------------------------
# parse_rows: pure unit tests
# ---------------------------------------------------------------------------


def test_parse_rows_extracts_required_fields() -> None:
    txns, rows_read, dropped = parse_rows(CSV_BASIC, AK)
    assert rows_read == 2 and dropped == 0
    assert len(txns) == 2
    assert txns[0].posted_date == date(2026, 8, 1)
    assert txns[0].amount == -12.34
    assert txns[0].description == "AMAZON.COM"
    assert txns[0].currency == "USD"


def test_parse_rows_is_header_case_insensitive_and_order_independent() -> None:
    csv_text = "Description,Date,Amount\nCOFFEE,08/03/2026,-4.50\n"
    txns, _, dropped = parse_rows(csv_text, AK)
    assert dropped == 0
    assert txns[0].posted_date == date(2026, 8, 3)
    assert txns[0].description == "COFFEE"


def test_parse_rows_accepts_accounting_negative_amount() -> None:
    csv_text = "date,amount,description\n2026-08-01,(12.34),REFUND REVERSAL\n"
    txns, _, _ = parse_rows(csv_text, AK)
    assert txns[0].amount == -12.34


def test_parse_rows_accepts_currency_symbols_and_commas() -> None:
    csv_text = "date,amount,description\n2026-08-01,\"$1,234.56\",BIG DEPOSIT\n"
    txns, _, _ = parse_rows(csv_text, AK)
    assert txns[0].amount == 1234.56


def test_parse_rows_respects_optional_currency_column() -> None:
    csv_text = "date,amount,description,currency\n2026-08-01,-1.00,COFFEE,EUR\n"
    txns, _, _ = parse_rows(csv_text, AK)
    assert txns[0].currency == "EUR"


def test_parse_rows_rejects_a_header_missing_required_columns() -> None:
    with pytest.raises(ValueError):
        parse_rows("date,description\n2026-08-01,COFFEE\n", AK)


def test_parse_rows_drops_and_counts_malformed_rows() -> None:
    csv_text = (
        "date,amount,description\n"
        "2026-08-01,-1.00,GOOD ROW\n"
        "not-a-date,-1.00,BAD DATE\n"
        "2026-08-01,not-a-number,BAD AMOUNT\n"
        "2026-08-01,-1.00,\n"  # blank description
        "\n"  # blank line, not counted as a row
    )
    txns, rows_read, dropped = parse_rows(csv_text, AK)
    assert len(txns) == 1
    assert rows_read == 4
    assert dropped == 3


def test_parse_rows_handles_an_empty_file() -> None:
    txns, rows_read, dropped = parse_rows("", AK)
    assert txns == [] and rows_read == 0 and dropped == 0


# ---------------------------------------------------------------------------
# import_csv: integration against the kernel
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def money_ctx(clean_database: None) -> AccessContext:
    ctx = money_context()
    define_money_types(ctx)
    return ctx


def test_import_creates_account_and_transactions_linked_to_a_receipt(
    money_ctx: AccessContext,
) -> None:
    report = import_csv(money_ctx, CSV_BASIC.encode(), "Checking")

    assert report.write.accounts_created == 1
    assert report.write.created == 2
    assert report.rows_read == 2 and report.rows_dropped == 0
    assert report.write.receipt_id is not None

    receipt = get_entity(money_ctx, report.write.receipt_id)
    assert "money_source_receipt" in receipt.types
    assert receipt.entity.attributes["source"] == "csv"
    assert receipt.entity.attributes["transaction_count"] == 2

    ak = account_key("csv", "Checking")
    (account,) = find(money_ctx, type_name="account", filters={"account_key": ak})
    assert account.attributes["name"] == "Checking"

    (txn,) = find(
        money_ctx, type_name="transaction", filters={"normalized_desc": "amazon.com"}
    )
    assert txn.attributes["amount"] == -12.34

    edges = get_entity(money_ctx, txn.id).edges_out
    derived = [e for e in edges if e.relation == DERIVED_FROM]
    assert derived and derived[0].to_entity == report.write.receipt_id
    assert derived[0].attributes["method"] == METHOD


def event_count() -> int:
    from kernel import db

    with db.connect() as conn:
        row = conn.execute("select count(*) as n from event").fetchone()
        assert row is not None
        return int(row["n"])


def test_reimporting_an_identical_file_emits_nothing(money_ctx: AccessContext) -> None:
    content = (b"date,amount,description\n2026-08-10,-5.00,DUPLICATE TEST\n")
    first = import_csv(money_ctx, content, "Dup Account")
    assert not first.write.unchanged

    before = event_count()
    second = import_csv(money_ctx, content, "Dup Account")
    assert second.write.unchanged
    assert second.write.receipt_id == first.write.receipt_id
    assert event_count() == before  # the idempotency proof


def test_reimporting_an_overlapping_date_range_dedupes_by_row(
    money_ctx: AccessContext,
) -> None:
    first_content = (
        b"date,amount,description\n"
        b"2026-08-11,-1.00,OVERLAP A\n"
        b"2026-08-12,-2.00,OVERLAP B\n"
    )
    first = import_csv(money_ctx, first_content, "Overlap Account")
    assert first.write.created == 2

    # A second, wider export that repeats both rows plus one new one.
    second_content = (
        b"date,amount,description\n"
        b"2026-08-11,-1.00,OVERLAP A\n"
        b"2026-08-12,-2.00,OVERLAP B\n"
        b"2026-08-13,-3.00,OVERLAP C\n"
    )
    second = import_csv(money_ctx, second_content, "Overlap Account")
    assert not second.write.unchanged
    assert second.write.created == 1  # only the new row
    assert second.write.updated == 0


def test_malformed_and_duplicate_rows_are_skipped_and_counted(money_ctx: AccessContext) -> None:
    content = (
        b"date,amount,description\n"
        b"2026-08-20,-1.00,ROW ONE\n"
        b"2026-08-20,-1.00,ROW ONE\n"  # exact duplicate within the same file
        b"bad-date,-1.00,BAD ROW\n"
    )
    report = import_csv(money_ctx, content, "Skip Account")
    assert report.write.created == 1
    assert report.write.skipped >= 1  # the in-file duplicate
    assert report.rows_dropped == 1  # the malformed row


def test_erasure_survives_a_reimport(money_ctx: AccessContext) -> None:
    content = (b"date,amount,description\n2026-08-25,-9.99,ERASE ME\n")
    import_csv(money_ctx, content, "Erase Account")
    (txn,) = find(money_ctx, type_name="transaction", filters={"normalized_desc": "erase me"})

    forget(money_ctx, txn.id, fields=["amount", "description"])
    assert redacted_fields(money_ctx, txn.id) >= {"amount", "description"}

    import_csv(money_ctx, content, "Erase Account")
    (still_erased,) = find(
        money_ctx, type_name="transaction", filters={"normalized_desc": "erase me"}
    )
    assert "amount" not in still_erased.attributes
    assert "description" not in still_erased.attributes


def test_import_rejects_oversized_file(money_ctx: AccessContext) -> None:
    with pytest.raises(ValueError):
        import_csv(money_ctx, b"x" * (9 * 1024 * 1024), "Huge Account")


# ---------------------------------------------------------------------------
# The CLI job: missing/unreadable file and malformed-header failure paths
# ---------------------------------------------------------------------------


def test_job_fails_when_file_does_not_exist(
    tmp_path: Path, money_ctx: AccessContext
) -> None:
    missing = tmp_path / "does-not-exist.csv"
    assert main([str(missing)]) == 1
    receipts = find(money_ctx, type_name="execution_receipt", filters={"job": METHOD})
    assert receipts and receipts[-1].attributes["status"] == "failed"


def test_job_fails_on_a_malformed_header(tmp_path: Path, money_ctx: AccessContext) -> None:
    path = tmp_path / "bad.csv"
    path.write_text("foo,bar\n1,2\n")
    assert main([str(path)]) == 1
    receipts = find(money_ctx, type_name="execution_receipt", filters={"job": METHOD})
    assert receipts and receipts[-1].attributes["status"] == "failed"


def test_job_succeeds_with_a_usage_error_when_no_path_given() -> None:
    assert main([]) == 2


def test_job_succeeds_and_ingests_a_real_file(tmp_path: Path, money_ctx: AccessContext) -> None:
    path = tmp_path / "statement.csv"
    path.write_text(CSV_BASIC)
    assert main([str(path), "Job Account"]) == 0
    receipts = find(money_ctx, type_name="execution_receipt", filters={"job": METHOD})
    assert receipts and receipts[-1].attributes["status"] == "ok"
