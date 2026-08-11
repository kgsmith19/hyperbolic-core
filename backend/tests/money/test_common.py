"""Unit: pure hashing/normalize helpers (roadmap C0)."""

from datetime import date

from domains.money.common import account_key, normalize_description, transaction_key


def test_account_key_is_stable_for_the_same_source_and_ref() -> None:
    assert account_key("csv", "Chase Checking") == account_key("csv", "Chase Checking")


def test_account_key_is_case_and_whitespace_insensitive() -> None:
    assert account_key("csv", " Chase Checking ") == account_key("csv", "chase checking")


def test_account_key_differs_by_source() -> None:
    assert account_key("csv", "abc") != account_key("simplefin", "abc")


def test_account_key_is_a_sha256_hex_digest() -> None:
    key = account_key("csv", "abc")
    assert len(key) == 64
    int(key, 16)  # raises if not hex


def test_normalize_description_lowercases_and_collapses_whitespace() -> None:
    assert normalize_description("  AMAZON.COM   AMZN.COM/BI  ") == "amazon.com amzn.com/bi"


def test_transaction_key_is_stable_for_identical_inputs() -> None:
    ak = account_key("csv", "acct")
    a = transaction_key(ak, date(2026, 8, 1), -12.34, "amazon")
    b = transaction_key(ak, date(2026, 8, 1), -12.34, "amazon")
    assert a == b


def test_transaction_key_changes_when_any_component_changes() -> None:
    ak = account_key("csv", "acct")
    base = transaction_key(ak, date(2026, 8, 1), -12.34, "amazon")
    assert base != transaction_key(ak, date(2026, 8, 2), -12.34, "amazon")
    assert base != transaction_key(ak, date(2026, 8, 1), -12.35, "amazon")
    assert base != transaction_key(ak, date(2026, 8, 1), -12.34, "target")
    assert base != transaction_key(account_key("csv", "other"), date(2026, 8, 1), -12.34, "amazon")


def test_transaction_key_rounds_amount_to_cents() -> None:
    ak = account_key("csv", "acct")
    a = transaction_key(ak, date(2026, 8, 1), -12.340001, "amazon")
    b = transaction_key(ak, date(2026, 8, 1), -12.34, "amazon")
    assert a == b
