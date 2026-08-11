"""Recurring-charge and pay-period detection (roadmap C0.5).

Pure code, no ML and no new dependency, over the `transaction` events C0
(``domains.money.csv_import`` / ``simplefin_ingest``) already wrote. Two
passes:

1. **Recurring-charge detection** (``detect_recurring``) groups transactions
   by ``(account_key, normalized_desc)`` -- the merchant, deduped against
   double-counting the same entity twice -- and asks whether the group is a
   single, regular series: enough occurrences, one cadence bucket every
   interval agrees on, and an amount that does not drift past tolerance.
   **The moment any one of those fails, the series is written as
   ``status: "review"`` with a ``review_reason`` naming which check failed --
   never silently promoted to ``"confirmed"``.** This is the crux of the
   acceptance bar: ambiguity must read as ambiguity downstream, not get
   guessed into a fact. The review queue is nothing new -- it is exactly the
   ``recurring_charge`` records this pass already writes with
   ``status: "review"``, the same "status the promotion never fires for"
   shape `domains.bills.verify` uses for `candidate`.

2. **Pay-period detection** (``detect_pay_periods``) builds windows only from
   a recurring series that is BOTH ``status: "confirmed"`` AND a deposit
   (positive ``typical_amount``) AND cadenced at 7, 14 or 30 days -- the
   paycheck cadences. A ``review`` series is never consulted: an ambiguous
   deposit pattern must not silently become a pay-period fact any more than
   an ambiguous charge may become a confirmed subscription. Zero qualifying
   series is reported honestly as "no paychecks found" rather than
   fabricating a period from whatever deposits exist; more than one
   qualifying series on the same account is reported as ambiguous (which
   deposit stream is "the" paycheck is not this code's call to make).

Ambiguity threshold, spelled out (also see ``MIN_CONFIRMED_OCCURRENCES``,
``CADENCE_BUCKETS``, ``AMOUNT_REL_TOLERANCE``, ``AMOUNT_ABS_FLOOR`` below):
a series needs at least 3 occurrences (2 gives one interval, which is not
enough to call a cadence *regular* rather than merely *observed once*);
every consecutive interval must fall within slack of the SAME cadence bucket
(a series whose intervals fall near two different buckets, or near none, is
irregular); and every amount must sit within 15% of the series median (or
within a flat $3 for small amounts, so a $4.99/$5.49 coffee-shop tier does
not fail on tolerance percentage alone) -- past that, the amount is drifting
enough that treating it as "the same charge" would be a guess.

``months_of_cover`` (the weekly rider, roadmap C0.5) is a pure function over
two operator-supplied numbers -- liquid balance and an essential-monthly
baseline the operator sets, since C0 tracks no account balance at all (its
own "pre-made decision: no balances-forecasting"). It performs no I/O, reads
nothing from the kernel, and writes nothing: **advisory and read-only by
construction**, not merely by convention. There is no capture call anywhere
in this module for it because there is nothing to persist -- a number
computed fresh from operator-supplied inputs every time it is asked for.

No payment, cancellation, transfer or other outward action exists anywhere
in this module (invariant 8 / ADR 018, the money cell's own posture) --
every function here either derives read-only entities from transactions
already on record or computes a number and returns it.
"""

import statistics
from dataclasses import dataclass
from datetime import date, timedelta
from hashlib import sha256
from uuid import UUID

from domains.money.common import money_context
from domains.money.types import (
    CADENCE_DAYS,
    REASON_AMOUNT_VARIANCE,
    REASON_CADENCE_IRREGULAR,
    REASON_INSUFFICIENT_HISTORY,
    REASON_MISSING_PAYCHECKS,
    REASON_MULTIPLE_PAYCHECK_SERIES,
    STATUS_CONFIRMED,
    STATUS_REVIEW,
    define_money_types,
)
from domains.ops.receipts import STATUS_OK, JobResult, run_job
from kernel import services
from kernel.access import AccessContext
from kernel.models import Entity

METHOD = "domains.money.recurring"

# --- ambiguity thresholds, named once and used nowhere else --------------

MIN_CONFIRMED_OCCURRENCES = 3  # fewer than this: cadence is unproven, not just unlucky
MIN_REVIEW_OCCURRENCES = 2  # fewer than this: no series signal at all -- not reported

# cadence bucket (days) -> slack (days either side) a matching interval may sit within.
CADENCE_BUCKETS: dict[int, int] = {7: 2, 14: 3, 30: 5, 90: 7, 365: 15}
assert sorted(CADENCE_BUCKETS) == CADENCE_DAYS  # the type schema's enum must match exactly

AMOUNT_REL_TOLERANCE = 0.15  # 15% of the series median
AMOUNT_ABS_FLOOR = 3.00  # or this many dollars, whichever is more forgiving

PAYCHECK_CADENCES = frozenset({7, 14, 30})  # weekly / biweekly / monthly deposit rhythms

MAX_EVIDENCE_IDS = 200

# Confidence is never 1.0 for a review-status record: a review record is an
# honest "we could not corroborate this", and 1.0 is reserved for what the
# detector actually confirmed (ADR 010 "an honest confidence").
CONFIDENCE_CONFIRMED = 1.0
CONFIDENCE_REVIEW = 0.4


@dataclass(frozen=True)
class TxnRecord:
    """The slice of a `transaction` entity the detector needs. Built from
    kernel reads by the service-layer functions below; unit tests construct
    it directly so the clustering/cadence logic needs no database."""

    entity_id: UUID
    account_key: str
    posted_date: date
    amount: float
    normalized_desc: str


@dataclass(frozen=True)
class SeriesResult:
    """One merchant series' verdict. ``cadence_days`` is None whenever
    ``status`` is ``"review"``, regardless of *which* check failed -- a
    review record must never carry a field that reads as a confirmed
    derived fact (module docstring)."""

    account_key: str
    normalized_desc: str
    status: str
    review_reason: str | None
    cadence_days: int | None
    typical_amount: float
    occurrence_count: int
    first_seen: date
    last_seen: date
    transaction_ids: tuple[UUID, ...]

    @property
    def confirmed(self) -> bool:
        return self.status == STATUS_CONFIRMED

    def recurring_charge_key(self) -> str:
        body = f"{self.account_key}|{self.normalized_desc}"
        return sha256(body.encode()).hexdigest()


def _nearest_bucket(interval_days: int) -> int | None:
    """The single cadence bucket this interval sits within slack of, or None
    when it matches no bucket or ties between two (a tie is itself
    ambiguous, so it resolves to "no bucket" rather than picking one)."""
    matches = sorted(
        (abs(interval_days - bucket), bucket)
        for bucket, slack in CADENCE_BUCKETS.items()
        if abs(interval_days - bucket) <= slack
    )
    if not matches:
        return None
    if len(matches) > 1 and matches[0][0] == matches[1][0]:
        return None
    return matches[0][1]


def _dedupe(records: list[TxnRecord]) -> list[TxnRecord]:
    """Same entity counted once, first occurrence wins. Guards against
    duplicate data reaching the detector (a caller that reads the same
    transaction twice must not manufacture a same-day interval of 0, which
    would otherwise corrupt cadence detection rather than just being inert)."""
    seen: dict[UUID, TxnRecord] = {}
    for record in records:
        seen.setdefault(record.entity_id, record)
    return list(seen.values())


def analyze_series(records: list[TxnRecord]) -> SeriesResult | None:
    """One ``(account_key, normalized_desc)`` group's verdict, or None when
    there is only one occurrence -- a single sighting carries no series
    signal at all and is not reported in either state."""
    unique = sorted(_dedupe(records), key=lambda r: (r.posted_date, str(r.entity_id)))
    n = len(unique)
    if n < MIN_REVIEW_OCCURRENCES:
        return None

    account_key = unique[0].account_key
    normalized_desc = unique[0].normalized_desc
    amounts = [r.amount for r in unique]
    median_amount = statistics.median(amounts)
    ids = tuple(r.entity_id for r in unique[:MAX_EVIDENCE_IDS])
    first_seen = unique[0].posted_date
    last_seen = unique[-1].posted_date

    def review(reason: str, cadence_days: int | None = None) -> SeriesResult:
        return SeriesResult(
            account_key=account_key,
            normalized_desc=normalized_desc,
            status=STATUS_REVIEW,
            review_reason=reason,
            cadence_days=cadence_days,
            typical_amount=round(median_amount, 2),
            occurrence_count=n,
            first_seen=first_seen,
            last_seen=last_seen,
            transaction_ids=ids,
        )

    if n < MIN_CONFIRMED_OCCURRENCES:
        return review(REASON_INSUFFICIENT_HISTORY)

    tolerance = max(AMOUNT_ABS_FLOOR, abs(median_amount) * AMOUNT_REL_TOLERANCE)
    amount_ok = all(abs(a - median_amount) <= tolerance for a in amounts)

    intervals = [
        (b.posted_date - a.posted_date).days for a, b in zip(unique, unique[1:], strict=False)
    ]
    buckets = [_nearest_bucket(i) for i in intervals]
    distinct_buckets = {b for b in buckets if b is not None}
    cadence_ok = all(b is not None for b in buckets) and len(distinct_buckets) == 1

    if not cadence_ok:
        return review(REASON_CADENCE_IRREGULAR)
    if not amount_ok:
        # cadence_days is deliberately omitted here even though the cadence
        # itself resolved cleanly: this record's status is "review", and a
        # review record must never carry a field that reads as a confirmed
        # derived fact (module docstring's "never silently promote ambiguity
        # to fact") -- cadence_days is reserved for confirmed records only.
        return review(REASON_AMOUNT_VARIANCE)

    return SeriesResult(
        account_key=account_key,
        normalized_desc=normalized_desc,
        status=STATUS_CONFIRMED,
        review_reason=None,
        cadence_days=buckets[0],
        typical_amount=round(median_amount, 2),
        occurrence_count=n,
        first_seen=first_seen,
        last_seen=last_seen,
        transaction_ids=ids,
    )


def detect_recurring(records: list[TxnRecord]) -> list[SeriesResult]:
    """Every merchant series across the given transactions, confirmed or
    review. Pure: no I/O, no clock. Deterministic in input order (grouping
    keys are sorted before iteration) so re-running over the same data
    always yields the same list."""
    groups: dict[tuple[str, str], list[TxnRecord]] = {}
    for record in records:
        groups.setdefault((record.account_key, record.normalized_desc), []).append(record)

    results = []
    for key in sorted(groups):
        result = analyze_series(groups[key])
        if result is not None:
            results.append(result)
    return results


@dataclass(frozen=True)
class PayPeriod:
    account_key: str
    start_date: date
    end_date: date
    closed: bool
    cadence_days: int
    typical_amount: float
    transaction_ids: tuple[UUID, ...]

    def pay_period_key(self) -> str:
        body = f"{self.account_key}|{self.start_date.isoformat()}"
        return sha256(body.encode()).hexdigest()


@dataclass(frozen=True)
class PayPeriodResult:
    """Per-account outcome. ``periods`` is empty exactly when ``reason`` is
    set -- windows are never built from an account this run could not settle
    on a single paycheck series for."""

    account_key: str
    periods: tuple[PayPeriod, ...]
    reason: str | None


def detect_pay_periods(records: list[TxnRecord]) -> list[PayPeriodResult]:
    """Pay-period windows for every account with transactions, built ONLY
    from a confirmed paycheck-cadence deposit series (module docstring).
    Pure: no I/O, no clock -- the still-open final period's projected end
    date is derived from the series' own cadence, not from ``date.today()``,
    so this function is reproducible for any input regardless of when it
    runs.
    """
    groups: dict[tuple[str, str], list[TxnRecord]] = {}
    for record in records:
        groups.setdefault((record.account_key, record.normalized_desc), []).append(record)
    recurring = detect_recurring(records)

    by_account: dict[str, list[SeriesResult]] = {}
    for series in recurring:
        by_account.setdefault(series.account_key, []).append(series)

    accounts = sorted({r.account_key for r in records})
    results: list[PayPeriodResult] = []
    for account_key in accounts:
        candidates = [
            s
            for s in by_account.get(account_key, [])
            if s.confirmed and s.typical_amount > 0 and s.cadence_days in PAYCHECK_CADENCES
        ]
        if not candidates:
            results.append(PayPeriodResult(account_key, (), REASON_MISSING_PAYCHECKS))
            continue
        if len(candidates) > 1:
            results.append(PayPeriodResult(account_key, (), REASON_MULTIPLE_PAYCHECK_SERIES))
            continue

        series = candidates[0]
        deposits = sorted(
            _dedupe(groups[(account_key, series.normalized_desc)]), key=lambda r: r.posted_date
        )
        cadence = series.cadence_days
        assert cadence is not None
        periods: list[PayPeriod] = []
        for i, deposit in enumerate(deposits):
            if i + 1 < len(deposits):
                end = deposits[i + 1].posted_date - timedelta(days=1)
                closed = True
            else:
                end = deposit.posted_date + timedelta(days=cadence - 1)
                closed = False
            periods.append(
                PayPeriod(
                    account_key=account_key,
                    start_date=deposit.posted_date,
                    end_date=end,
                    closed=closed,
                    cadence_days=cadence,
                    typical_amount=series.typical_amount,
                    transaction_ids=(deposit.entity_id,),
                )
            )
        results.append(PayPeriodResult(account_key, tuple(periods), None))
    return results


def months_of_cover(liquid_balance: float, essential_monthly_baseline: float) -> float | None:
    """The weekly review rider (roadmap C0.5). Pure function over two
    operator-supplied, already-verified numbers -- no kernel read, no write,
    no persistence. C0 tracks no account balance (its own "pre-made
    decision: no balances-forecasting"), so there is nothing here this
    module could derive the balance from itself; the caller supplies it.
    Returns None -- never a guess -- for a baseline that cannot mean
    "months of spending" (zero or negative) or a negative balance."""
    if essential_monthly_baseline <= 0 or liquid_balance < 0:
        return None
    return round(liquid_balance / essential_monthly_baseline, 2)


# --- persistence: read transactions, write recurring_charge / pay_period ---


def _provenance(series_or_period: SeriesResult | PayPeriod, ctx: AccessContext) -> dict:
    ids = series_or_period.transaction_ids
    confidence = (
        CONFIDENCE_CONFIRMED
        if isinstance(series_or_period, PayPeriod) or series_or_period.confirmed
        else CONFIDENCE_REVIEW
    )
    return {
        "source_entity_ids": [str(i) for i in ids],
        "source_event_ids": services.latest_event_ids(ctx, list(ids)),
        "method": METHOD,
        "confidence": confidence,
    }


@dataclass
class RecurringReport:
    series_seen: int = 0
    confirmed: int = 0
    review: int = 0
    created: int = 0
    updated: int = 0
    unchanged: int = 0

    def line(self) -> str:
        return (
            f"recurring: series_seen={self.series_seen} confirmed={self.confirmed} "
            f"review={self.review} created={self.created} updated={self.updated} "
            f"unchanged={self.unchanged}"
        )


def _all_transactions(ctx: AccessContext) -> list[TxnRecord]:
    entities = services.find(ctx, type_name="transaction")
    records = []
    for entity in entities:
        attrs = entity.attributes
        posted = attrs.get("posted_date")
        amount = attrs.get("amount")
        normalized_desc = attrs.get("normalized_desc")
        account_key = attrs.get("account_key")
        if not isinstance(posted, str) or amount is None:
            continue  # amount/description are x-pii and forget()-erasable; skip an erased row
        if not isinstance(normalized_desc, str) or not isinstance(account_key, str):
            continue
        try:
            posted_date = date.fromisoformat(posted)
        except ValueError:
            continue
        records.append(
            TxnRecord(
                entity_id=entity.id,
                account_key=account_key,
                posted_date=posted_date,
                amount=float(amount),
                normalized_desc=normalized_desc,
            )
        )
    return records


def _write_recurring_charge(ctx: AccessContext, series: SeriesResult) -> tuple[bool, bool]:
    """Returns (created, updated)."""
    attributes: dict = {
        "recurring_charge_key": series.recurring_charge_key(),
        "account_key": series.account_key,
        "normalized_desc": series.normalized_desc,
        "status": series.status,
        "typical_amount": series.typical_amount,
        "occurrence_count": series.occurrence_count,
        "first_seen": series.first_seen.isoformat(),
        "last_seen": series.last_seen.isoformat(),
        "provenance": _provenance(series, ctx),
    }
    if series.review_reason is not None:
        attributes["review_reason"] = series.review_reason
    if series.cadence_days is not None:
        attributes["cadence_days"] = series.cadence_days

    key_filter = {"recurring_charge_key": attributes["recurring_charge_key"]}
    matches = services.find(ctx, type_name="recurring_charge", filters=key_filter)
    if matches and all(
        matches[0].attributes.get(k) == v for k, v in attributes.items() if k != "provenance"
    ):
        return False, False  # unchanged: emit nothing (not even a provenance rewrite)
    services.capture(ctx, "recurring_charge", attributes, actor=METHOD)
    return (not matches), bool(matches)


def run_recurring_detection(ctx: AccessContext) -> RecurringReport:
    """Detect every recurring series over every transaction on record and
    write/update its `recurring_charge`. Idempotent: unchanged verdicts emit
    nothing (checked before any capture call, mirroring
    `domains.money.common.write_transactions`)."""
    define_money_types(ctx)
    records = _all_transactions(ctx)
    series = detect_recurring(records)
    report = RecurringReport(series_seen=len(series))
    for s in series:
        if s.confirmed:
            report.confirmed += 1
        else:
            report.review += 1
        created, updated = _write_recurring_charge(ctx, s)
        if created:
            report.created += 1
        elif updated:
            report.updated += 1
        else:
            report.unchanged += 1
    return report


@dataclass
class PayPeriodReport:
    accounts_seen: int = 0
    periods_written: int = 0
    accounts_missing_paychecks: int = 0
    accounts_ambiguous: int = 0
    created: int = 0
    updated: int = 0
    unchanged: int = 0

    def line(self) -> str:
        return (
            f"pay_period: accounts_seen={self.accounts_seen} "
            f"periods_written={self.periods_written} "
            f"missing_paychecks={self.accounts_missing_paychecks} "
            f"ambiguous={self.accounts_ambiguous} created={self.created} updated={self.updated} "
            f"unchanged={self.unchanged}"
        )


def _write_pay_period(ctx: AccessContext, period: PayPeriod) -> tuple[bool, bool]:
    attributes = {
        "pay_period_key": period.pay_period_key(),
        "account_key": period.account_key,
        "start_date": period.start_date.isoformat(),
        "end_date": period.end_date.isoformat(),
        "closed": period.closed,
        "cadence_days": period.cadence_days,
        "typical_amount": period.typical_amount,
        "provenance": _provenance(period, ctx),
    }
    matches = services.find(
        ctx, type_name="pay_period", filters={"pay_period_key": attributes["pay_period_key"]}
    )
    if matches and all(
        matches[0].attributes.get(k) == v for k, v in attributes.items() if k != "provenance"
    ):
        return False, False
    services.capture(ctx, "pay_period", attributes, actor=METHOD)
    return (not matches), bool(matches)


def run_pay_period_detection(ctx: AccessContext) -> PayPeriodReport:
    """Build pay-period windows for every account, from confirmed paycheck
    series only. Idempotent by the same rule as recurring-charge detection."""
    define_money_types(ctx)
    records = _all_transactions(ctx)
    results = detect_pay_periods(records)
    report = PayPeriodReport(accounts_seen=len(results))
    for result in results:
        if result.reason == REASON_MISSING_PAYCHECKS:
            report.accounts_missing_paychecks += 1
            continue
        if result.reason == REASON_MULTIPLE_PAYCHECK_SERIES:
            report.accounts_ambiguous += 1
            continue
        for period in result.periods:
            report.periods_written += 1
            created, updated = _write_pay_period(ctx, period)
            if created:
                report.created += 1
            elif updated:
                report.updated += 1
            else:
                report.unchanged += 1
    return report


def list_review_queue(ctx: AccessContext) -> list[Entity]:
    """Every `recurring_charge` this detector could not confirm -- the
    review queue. Nothing new: it is `status: "review"` records this
    module's own writes already produce (module docstring)."""
    return services.find(ctx, type_name="recurring_charge", filters={"status": STATUS_REVIEW})


def _job(ctx: AccessContext) -> JobResult:
    recurring_report = run_recurring_detection(ctx)
    print(recurring_report.line())
    period_report = run_pay_period_detection(ctx)
    print(period_report.line())
    return JobResult(
        status=STATUS_OK,
        summary=f"{recurring_report.line()} | {period_report.line()}",
        produced=[],
    )


def main(argv: list[str] | None = None) -> int:
    return run_job(money_context(), METHOD, _job)


if __name__ == "__main__":
    raise SystemExit(main())
