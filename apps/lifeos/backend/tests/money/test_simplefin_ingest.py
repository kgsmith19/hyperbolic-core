"""SimpleFIN ingestion tests (roadmap C0).

`parse_account`/`parse_transaction` are pure and unit-tested directly;
`ingest_accounts` and the scheduled job (`main`) are integration-tested
against the real kernel, mirroring `domains.cpap.ingest`'s idempotency and
credential-handling proofs.
"""

import os
from collections.abc import Iterator
from datetime import UTC, date, datetime
from hashlib import sha256
from typing import Any

import pytest

from domains.money.common import DERIVED_FROM, account_key
from domains.money.simplefin_client import SimpleFinError
from domains.money.simplefin_ingest import (
    METHOD,
    ingest_accounts,
    main,
    money_context,
    parse_account,
    parse_transaction,
    simplefin_access_url,
)
from domains.money.types import define_money_types
from kernel.access import AccessContext
from kernel.services import find, forget, get_entity, redacted_fields
from tests.support import event_count

WINDOW_START = date(2026, 8, 1)
WINDOW_END = date(2026, 8, 5)


def sf_account(account_id: str = "ACT-1", **extra: Any) -> dict[str, Any]:
    return {"id": account_id, "name": "Checking", "currency": "usd", "transactions": [], **extra}


def sf_txn(
    txn_id: str = "TXN-1", posted: str = "2026-08-01", amount: str = "-12.34", **extra: Any
) -> dict[str, Any]:
    ts = int(datetime.strptime(posted, "%Y-%m-%d").replace(tzinfo=UTC).timestamp())
    return {"id": txn_id, "posted": ts, "amount": amount, "description": "AMAZON.COM", **extra}


def fake_sha(label: str) -> str:
    """A real 64-char hex digest for a test's `payload_sha` arg -- the schema
    validates `sha256` strictly as `^[0-9a-f]{64}$`, so a placeholder string
    like "sha-dup" fails capture. `label` keeps each call site's intent
    readable while still producing a valid digest."""
    return sha256(label.encode()).hexdigest()


# ---------------------------------------------------------------------------
# parse_account / parse_transaction: pure unit tests
# ---------------------------------------------------------------------------


def test_parse_account_extracts_key_name_and_currency() -> None:
    parsed = parse_account(sf_account())
    assert parsed is not None
    key, name, currency, txns = parsed
    assert key == account_key("simplefin", "ACT-1")
    assert name == "Checking"
    assert currency == "USD"
    assert txns == []


@pytest.mark.parametrize(
    "raw",
    ["not a dict", {}, {"id": ""}, {"id": 123}],
)
def test_parse_account_drops_malformed_input(raw: Any) -> None:
    assert parse_account(raw) is None


def test_parse_transaction_extracts_all_fields() -> None:
    ak = account_key("simplefin", "ACT-1")
    parsed = parse_transaction(sf_txn(pending=True), ak)
    assert parsed is not None
    assert parsed.account_key == ak
    assert parsed.posted_date == date(2026, 8, 1)
    assert parsed.amount == -12.34
    assert parsed.description == "AMAZON.COM"
    assert parsed.pending is True
    assert parsed.external_id == "TXN-1"


@pytest.mark.parametrize(
    "raw",
    [
        "not a dict",
        {},
        {"posted": "not-a-number", "amount": "1", "description": "x"},
        {"posted": True, "amount": "1", "description": "x"},  # bool, not a real number
        {"posted": 1690000000, "amount": None, "description": "x"},
        {"posted": 1690000000, "amount": "not-a-number", "description": "x"},
        {"posted": 1690000000, "amount": "1.23", "description": ""},
        {"posted": 1690000000, "amount": "1.23", "description": "   "},
        {"posted": 1690000000, "amount": "1.23"},  # missing description
    ],
)
def test_parse_transaction_drops_malformed_input(raw: Any) -> None:
    assert parse_transaction(raw, "ak") is None


# ---------------------------------------------------------------------------
# ingest_accounts: integration against the kernel
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def money_ctx(clean_database: None) -> AccessContext:
    ctx = money_context()
    define_money_types(ctx)
    return ctx


def test_ingest_creates_account_and_transactions_linked_to_a_receipt(
    money_ctx: AccessContext,
) -> None:
    raw = [sf_account(transactions=[sf_txn("T1", "2026-08-01"), sf_txn("T2", "2026-08-02")])]
    report = ingest_accounts(money_ctx, raw, WINDOW_START, WINDOW_END, fake_sha("sha-1"))

    assert report.accounts_created == 1
    assert report.created == 2 and report.updated == 0
    assert not report.unchanged and report.receipt_id is not None

    receipt = get_entity(money_ctx, report.receipt_id)
    assert "money_source_receipt" in receipt.types
    assert receipt.entity.attributes["transaction_count"] == 2
    assert receipt.entity.attributes["source"] == "simplefin"

    ak = account_key("simplefin", "ACT-1")
    (account,) = find(money_ctx, type_name="account", filters={"account_key": ak})
    assert account.attributes["name"] == "Checking"

    (txn,) = find(money_ctx, type_name="transaction", filters={"external_id": "T1"})
    assert txn.attributes["amount"] == -12.34
    assert txn.attributes["account_key"] == ak

    edges = get_entity(money_ctx, txn.id).edges_out
    derived = [e for e in edges if e.relation == DERIVED_FROM]
    assert derived and derived[0].to_entity == report.receipt_id
    assert derived[0].attributes["method"] == METHOD
    assert derived[0].attributes["confidence"] == 1.0


def test_replaying_the_identical_response_emits_nothing(money_ctx: AccessContext) -> None:
    raw = [sf_account("ACT-DUP", transactions=[sf_txn("D1", "2026-08-03")])]
    sha = fake_sha("sha-dup")
    first = ingest_accounts(money_ctx, raw, WINDOW_START, WINDOW_END, sha)
    assert not first.unchanged

    before = event_count()
    second = ingest_accounts(money_ctx, raw, WINDOW_START, WINDOW_END, sha)
    assert second.unchanged
    assert second.receipt_id == first.receipt_id
    assert event_count() == before  # the idempotency proof


def test_an_amount_change_mints_a_new_transaction_and_leaves_the_unchanged_one_alone(
    money_ctx: AccessContext,
) -> None:
    """`transaction_key` hashes (account, posted_date, amount,
    normalized_desc) -- the roadmap's own idempotency tuple. Changing the
    amount therefore changes the identity itself: the prior row is left
    exactly as it was (a real revision-tracking / correction feature is out
    of C0's scope) and a second, distinct transaction is created — the same
    outcome two genuinely distinct same-day transactions would produce. The
    unrelated, unchanged sibling (C1) must not be recreated or touched."""
    first = ingest_accounts(
        money_ctx,
        [
            sf_account(
                "ACT-CHG",
                transactions=[
                    sf_txn("C1", "2026-08-04", "-1.00"),
                    sf_txn("C2", "2026-08-05", "-2.00"),
                ],
            )
        ],
        WINDOW_START,
        WINDOW_END,
        fake_sha("sha-chg-1"),
    )
    assert first.created == 2
    (c1_before,) = find(money_ctx, type_name="transaction", filters={"external_id": "C1"})

    second = ingest_accounts(
        money_ctx,
        [
            sf_account(
                "ACT-CHG",
                transactions=[
                    sf_txn("C1", "2026-08-04", "-1.00"),
                    sf_txn("C2", "2026-08-05", "-9.99"),  # only C2's amount changed
                ],
            )
        ],
        WINDOW_START,
        WINDOW_END,
        fake_sha("sha-chg-2"),
    )
    assert not second.unchanged
    assert second.created == 1  # C2's new amount is a new transaction_key
    assert second.updated == 0  # C1 is untouched, not "updated"

    (c1_after,) = find(money_ctx, type_name="transaction", filters={"external_id": "C1"})
    assert c1_after.id == c1_before.id  # same entity, not recreated

    c2_amounts = {
        t.attributes["amount"]
        for t in find(money_ctx, type_name="transaction", filters={"external_id": "C2"})
    }
    assert c2_amounts == {-2.00, -9.99}  # both C2 rows coexist


def test_changing_a_non_identity_field_updates_the_existing_transaction(
    money_ctx: AccessContext,
) -> None:
    """`pending` is not part of `transaction_key`, so a SimpleFIN transaction
    flipping from pending to posted (same account/date/amount/description)
    is a genuine in-place update, not a new transaction."""
    first = ingest_accounts(
        money_ctx,
        [sf_account("ACT-PEND", transactions=[sf_txn("P1", "2026-08-04", "-3.00", pending=True)])],
        WINDOW_START,
        WINDOW_END,
        fake_sha("sha-pend-1"),
    )
    assert first.created == 1

    second = ingest_accounts(
        money_ctx,
        [sf_account("ACT-PEND", transactions=[sf_txn("P1", "2026-08-04", "-3.00", pending=False)])],
        WINDOW_START,
        WINDOW_END,
        fake_sha("sha-pend-2"),
    )
    assert not second.unchanged
    assert second.created == 0
    assert second.updated == 1

    (txn,) = find(money_ctx, type_name="transaction", filters={"external_id": "P1"})
    assert txn.attributes["pending"] is False


def test_malformed_and_out_of_window_transactions_are_skipped(money_ctx: AccessContext) -> None:
    raw = [
        sf_account(
            "ACT-BAD",
            transactions=[
                sf_txn("B1", "2026-08-01"),
                {"id": "bad", "posted": "nope", "amount": "1", "description": "x"},
                sf_txn("B2", "2026-07-01"),  # outside the pull window
            ],
        )
    ]
    report = ingest_accounts(money_ctx, raw, WINDOW_START, WINDOW_END, fake_sha("sha-bad"))
    assert report.created == 1  # only B1 lands


def test_erasure_survives_a_replay(money_ctx: AccessContext) -> None:
    raw = [sf_account("ACT-ERASE", transactions=[sf_txn("E1", "2026-08-01", "-9.99")])]
    ingest_accounts(money_ctx, raw, WINDOW_START, WINDOW_END, fake_sha("sha-erase-1"))
    (txn,) = find(money_ctx, type_name="transaction", filters={"external_id": "E1"})

    forget(money_ctx, txn.id, fields=["amount", "description"])
    assert redacted_fields(money_ctx, txn.id) >= {"amount", "description"}

    ingest_accounts(money_ctx, raw, WINDOW_START, WINDOW_END, fake_sha("sha-erase-2"))
    (still_erased,) = find(money_ctx, type_name="transaction", filters={"external_id": "E1"})
    assert "amount" not in still_erased.attributes
    assert "description" not in still_erased.attributes


# ---------------------------------------------------------------------------
# The scheduled job: credential-missing skip, failure, and success paths
# ---------------------------------------------------------------------------


@pytest.fixture
def clear_simplefin_env() -> Iterator[None]:
    saved = os.environ.pop("LIFEOS_SIMPLEFIN_ACCESS_URL", None)
    yield
    if saved is not None:
        os.environ["LIFEOS_SIMPLEFIN_ACCESS_URL"] = saved
    else:
        os.environ.pop("LIFEOS_SIMPLEFIN_ACCESS_URL", None)


def test_access_url_is_none_when_unset(clear_simplefin_env: None) -> None:
    assert simplefin_access_url() is None


def test_job_skips_with_no_access_url(clear_simplefin_env: None, money_ctx: AccessContext) -> None:
    assert main() == 1  # skipped is a non-zero exit (ADR 014: not a quiet no-op)
    receipts = find(money_ctx, type_name="execution_receipt", filters={"job": METHOD})
    assert receipts and receipts[-1].attributes["status"] == "skipped"


def test_job_reports_failed_when_simplefin_errors(
    clear_simplefin_env: None, money_ctx: AccessContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    os.environ["LIFEOS_SIMPLEFIN_ACCESS_URL"] = "https://user:pass@bridge.simplefin.org/simplefin"

    def boom(*args: Any, **kwargs: Any) -> Any:
        raise SimpleFinError("response carried no accounts list")

    monkeypatch.setattr("domains.money.simplefin_ingest.fetch_accounts", boom)

    assert main() == 1
    receipts = find(money_ctx, type_name="execution_receipt", filters={"job": METHOD})
    assert receipts and receipts[-1].attributes["status"] == "failed"
    # The access URL/credential must never land in the receipt's summary.
    assert "user:pass" not in receipts[-1].attributes["summary"]


def test_job_succeeds_and_ingests_when_simplefin_responds(
    clear_simplefin_env: None, money_ctx: AccessContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    os.environ["LIFEOS_SIMPLEFIN_ACCESS_URL"] = "https://user:pass@bridge.simplefin.org/simplefin"

    monkeypatch.setattr(
        "domains.money.simplefin_ingest.fetch_accounts",
        lambda *a, **k: [sf_account("ACT-JOB", transactions=[sf_txn("J1", "2026-08-01")])],
    )

    assert main() == 0
    receipts = find(money_ctx, type_name="execution_receipt", filters={"job": METHOD})
    assert receipts and receipts[-1].attributes["status"] == "ok"
