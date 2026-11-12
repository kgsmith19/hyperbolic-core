"""Two-minute action launcher acceptance tests (#574). Synthetic rows only."""

from datetime import date
from decimal import Decimal
from uuid import uuid4

from domains.agents.roles import Role, default_registry
from domains.bills.forecast import BillLedgerRow, forecast
from domains.bills.launcher import ESTIMATED_MINUTES, PERMISSION, ROLE, launch, plan_for, plans
from kernel.access import AccessContext

START = date(2026, 11, 1)
END = date(2026, 11, 30)
AS_OF = date(2026, 11, 15)
CTX = AccessContext.all()


def _rows(*rows: BillLedgerRow):
    return forecast(list(rows), window_start=START, window_end=END, as_of=AS_OF).rows


def _row(bill: str, due: date, **over: object) -> BillLedgerRow:
    base = dict(
        bill_id=bill,
        due_date=due,
        amount=Decimal("80.00"),
        payment_status="unpaid",
        payment_evidence_id=None,
        balance_fresh=True,
        excluded=False,
    )
    base.update(over)
    return BillLedgerRow(**base)  # type: ignore[arg-type]


def test_an_overdue_unpaid_bill_gets_a_two_minute_confirm_payment_step() -> None:
    bill = f"gas-{uuid4().hex[:8]}"
    rows = _rows(_row(bill, date(2026, 11, 5)))

    plan = plan_for(rows[0], AS_OF)

    assert plan is not None
    assert plan.kind == "confirm_payment"
    assert plan.minutes == ESTIMATED_MINUTES == 2
    assert bill in plan.summary


def test_a_failed_autopay_gets_a_resolve_step_even_when_not_yet_overdue() -> None:
    bill = f"auto-{uuid4().hex[:8]}"
    rows = _rows(_row(bill, date(2026, 11, 20), payment_status="autopay_failed"))

    plan = plan_for(rows[0], AS_OF)

    assert plan is not None
    assert plan.kind == "resolve_autopay_failure"


def test_an_unknown_amount_asks_for_confirmation_and_never_invents_a_number() -> None:
    bill = f"mystery-{uuid4().hex[:8]}"
    rows = _rows(_row(bill, date(2026, 11, 5), amount=None))

    plan = plan_for(rows[0], AS_OF)

    assert plan is not None
    assert plan.kind == "confirm_amount"
    assert "Decimal" not in plan.summary and "0.00" not in plan.summary


def test_paid_excluded_and_future_rows_get_no_plan() -> None:
    paid = f"paid-{uuid4().hex[:8]}"
    future = f"future-{uuid4().hex[:8]}"
    rows = _rows(
        _row(paid, date(2026, 11, 5), payment_status="paid", payment_evidence_id="bank-txn-1"),
        _row(future, date(2026, 11, 25)),
    )

    assert [plan_for(r, AS_OF) for r in rows] == [None, None]


def test_plans_are_built_only_from_bill_id_and_due_date_never_free_text() -> None:
    bill = f"private-{uuid4().hex[:8]}"
    plan = plan_for(_rows(_row(bill, date(2026, 11, 5)))[0], AS_OF)

    assert plan is not None
    assert set(plan.__slots__) == {"bill_id", "due_date", "kind", "summary", "minutes"}
    assert plan.due_date == date(2026, 11, 5)


def test_a_launch_writes_one_receipt_per_plan_and_repeats_write_nothing() -> None:
    bill = f"launch-{uuid4().hex[:8]}"
    rows = _rows(_row(bill, date(2026, 11, 5)))
    registry = default_registry()

    first = launch(CTX, registry, rows, AS_OF)
    second = launch(CTX, registry, rows, AS_OF)

    assert len(first) == 1 and first[0].receipt.allowed is True
    assert first[0].receipt.duplicate is False
    assert second[0].receipt.duplicate is True
    assert second[0].receipt.entity_id == first[0].receipt.entity_id


def test_a_launch_is_recorded_under_the_financial_role_and_draft_permission() -> None:
    bill = f"role-{uuid4().hex[:8]}"
    results = launch(CTX, default_registry(), _rows(_row(bill, date(2026, 11, 5))), AS_OF)

    assert ROLE is Role.FINANCIAL_OPERATIONS
    assert PERMISSION == "draft_dispute_packet"
    assert results[0].receipt.role == Role.FINANCIAL_OPERATIONS.value
    assert results[0].receipt.permission == PERMISSION


def test_plans_helper_returns_only_actionable_plans() -> None:
    bill = f"list-{uuid4().hex[:8]}"
    rows = _rows(_row(bill, date(2026, 11, 5)), _row(f"{bill}-future", date(2026, 11, 25)))

    assert [p.bill_id for p in plans(rows, AS_OF)] == [bill]
