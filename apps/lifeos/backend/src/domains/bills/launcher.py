"""Two-minute action launcher for overdue and failed bills (#574).

Turns a forecast row that needs attention into one concrete two-minute step, and
records that a launch decision was made as an agent action receipt.

This module never pays, transfers, or submits anything. A plan is a description
of the next human step (confirm the amount, resolve a failed AutoPay, confirm
payment with its evidence). Nothing here executes it.

Rules held here (from #574):

- Only rows that need attention get a plan: an overdue obligation, or a failed
  AutoPay. Paid, excluded and out-of-window rows get none.
- The plan's text is built only from the bill's id, its due date and the
  amount's presence. It never quotes ledger free text, so no personal detail is
  copied into a new record.
- An unknown amount is never turned into a number. The plan asks for confirmation.
- Each launch decision is recorded through the agent receipt gate, with an
  idempotency key built from the bill and its due date, so a repeat writes nothing.
"""

from dataclasses import dataclass
from datetime import date
from typing import Literal

from domains.agents.receipts import Receipt, record
from domains.agents.roles import Role, RoleRegistry
from domains.bills.forecast import FLAG_AUTOPAY_FAILED, FLAG_UNKNOWN_AMOUNT, ForecastRow
from kernel.access import AccessContext
from kernel.events import DEFAULT_ACTOR

LaunchKind = Literal["confirm_amount", "resolve_autopay_failure", "confirm_payment"]
ROLE = Role.FINANCIAL_OPERATIONS
# A launch is its own draft action (owner decision Q3), not a dispute packet.
PERMISSION = "launch_two_minute_action"
ESTIMATED_MINUTES = 2


@dataclass(frozen=True, slots=True)
class LaunchPlan:
    bill_id: str
    due_date: date
    kind: LaunchKind
    summary: str
    minutes: int


@dataclass(frozen=True, slots=True)
class LaunchResult:
    plan: LaunchPlan
    receipt: Receipt


def plan_for(row: ForecastRow, as_of: date) -> LaunchPlan | None:
    """The two-minute step for one forecast row as of `as_of`, or None when nothing needs doing.

    An unknown-amount bill is excluded from totals but still owed, so an overdue one
    still needs a confirm-amount step. Duplicates and out-of-window rows never get one.
    """
    bill = row.row.bill_id
    due = row.row.due_date
    if row.bucket == "obligation" and FLAG_AUTOPAY_FAILED in row.flags:
        return LaunchPlan(
            bill,
            due,
            "resolve_autopay_failure",
            f"AutoPay failed for {bill} due {due.isoformat()}: pay it or fix the method",
            ESTIMATED_MINUTES,
        )
    past_due_and_owed = due < as_of and row.row.payment_status in ("unpaid", "autopay_failed")
    if not past_due_and_owed:
        return None
    if row.bucket == "obligation":
        return LaunchPlan(
            bill,
            due,
            "confirm_payment",
            f"Confirm payment of {bill} (overdue since {due.isoformat()})",
            ESTIMATED_MINUTES,
        )
    if row.bucket == "excluded" and FLAG_UNKNOWN_AMOUNT in row.flags:
        return LaunchPlan(
            bill,
            due,
            "confirm_amount",
            f"Confirm the amount for {bill} (overdue since {due.isoformat()})",
            ESTIMATED_MINUTES,
        )
    return None


def plans(rows: list[ForecastRow], as_of: date) -> list[LaunchPlan]:
    return [plan for plan in (plan_for(row, as_of) for row in rows) if plan is not None]


def launch(
    ctx: AccessContext,
    registry: RoleRegistry,
    rows: list[ForecastRow],
    as_of: date,
    *,
    actor: str = DEFAULT_ACTOR,
) -> list[LaunchResult]:
    """Record one agent receipt per plan. Repeats return the original receipt."""
    results: list[LaunchResult] = []
    for plan in plans(rows, as_of):
        key = f"launch:{plan.kind}:{plan.bill_id}:{plan.due_date.isoformat()}"
        receipt = record(ctx, registry, ROLE, PERMISSION, key, actor=actor)
        results.append(LaunchResult(plan=plan, receipt=receipt))
    return results
