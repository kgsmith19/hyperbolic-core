"""Non-paying portal handoff contract. All bill data is synthetic."""
from dataclasses import replace
from datetime import date
from decimal import Decimal

import pytest

from domains.bills import launcher
from domains.bills.forecast import BillLedgerRow, forecast

TODAY = date(2026, 11, 14)


def row(**changes):
    bill = BillLedgerRow("synthetic-bill", date(2026, 11, 1), Decimal("10"),
                         "unpaid", None, True, False)
    bill = replace(bill, **changes)
    return forecast([bill], window_start=date(2026, 11, 1),
                    window_end=date(2026, 11, 30), as_of=TODAY).rows[0]


def prepare(item=None, provider="hagerstown", as_of=TODAY):
    fn = getattr(launcher, "prepare_payment_handoff", None)
    assert callable(fn), "launcher must offer non-paying payment preparation"
    return fn(row() if item is None else item, provider, as_of)


@pytest.mark.parametrize(("provider", "url"), [
    ("hagerstown", "https://www.hagerstownmd.org/1580/Online-Payment-Portal"),
    ("firstenergy", "https://www.firstenergycorp.com/help/billingpayments/ways-to-pay/guest-payment.html"),
    ("antietam", "https://www.antietambroadband.com/billing"),
])
def test_reviewed_portal_never_claims_authentication_or_execution(provider, url):
    result = prepare(provider=provider)
    assert result.status == "review_required"
    assert result.portal.url == url
    assert result.portal.source_url == url
    assert result.portal.verified_on == TODAY
    assert result.authentication_status == "not_checked"
    assert result.payee_match == "not_verified"
    assert result.executed is False
    assert result.plan.kind == "confirm_payment"
    assert not hasattr(result, "amount")


@pytest.mark.parametrize("provider", ["unknown", "https://evil.example/pay", "HAGERSTOWN", ""])
def test_unsupported_providers_never_become_urls(provider):
    result = prepare(provider=provider)
    assert result.status == "unsupported"
    assert result.portal is None
    assert result.executed is False


@pytest.mark.parametrize("as_of", [date(2026, 11, 13), date(2027, 2, 13)])
def test_future_verification_or_expired_catalog_requires_reverification(as_of):
    result = prepare(as_of=as_of)
    assert result.status == "blocked"
    assert result.reason == "portal_verification_required"
    assert result.portal is None


@pytest.mark.parametrize("changes", [
    {"payment_status": "paid", "payment_evidence_id": "synthetic-evidence"},
    {"payment_status": "paid"},
    {"excluded": True},
    {"due_date": date(2026, 12, 1)},
    {"payment_status": "unknown"},
])
def test_ineligible_rows_do_not_offer_payment_handoffs(changes):
    result = prepare(row(**changes))
    assert result.status == "blocked"
    assert result.portal is None


def test_duplicate_rows_cannot_offer_handoffs():
    bill = row().row
    duplicate = forecast([bill, bill], window_start=date(2026, 11, 1),
                         window_end=date(2026, 11, 30), as_of=TODAY).rows[0]
    assert prepare(duplicate).status == "blocked"
    assert prepare(duplicate).portal is None


@pytest.mark.parametrize(("changes", "reason"), [
    ({"amount": None}, "confirm_amount"),
    ({"balance_fresh": False}, "refresh_balance"),
    ({"amount": Decimal("0")}, "confirm_amount"),
])
def test_unknown_zero_or_stale_value_requires_review_without_payment_link(changes, reason):
    result = prepare(row(**changes))
    assert result.status == "blocked"
    assert result.reason == reason
    assert result.portal is None
    assert result.executed is False


def test_autopay_failure_preserves_existing_human_plan():
    result = prepare(row(payment_status="autopay_failed", due_date=date(2026, 11, 20)))
    assert result.status == "review_required"
    assert result.plan.kind == "resolve_autopay_failure"


def test_preparation_is_repeatable_without_mutating_input():
    item = row()
    before = repr(item)
    assert prepare(item) == prepare(item)
    assert repr(item) == before


def test_no_handoff_for_upcoming_unpaid_bill_without_an_actionable_plan():
    result = prepare(row(due_date=date(2026, 11, 20)))
    assert result.status == "blocked"
    assert result.reason == "no_action_needed"


@pytest.mark.parametrize("amount", [Decimal("NaN"), Decimal("Infinity"), Decimal("-1")])
def test_nonfinite_or_negative_amount_is_never_prepared(amount):
    item = row()
    item = replace(item, row=replace(item.row, amount=amount))
    assert prepare(item).reason == "confirm_amount"
    assert prepare(item).portal is None
