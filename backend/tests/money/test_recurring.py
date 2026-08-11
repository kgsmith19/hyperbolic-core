"""Recurring-charge and pay-period detection tests (roadmap C0.5).

`analyze_series` / `detect_recurring` / `detect_pay_periods` / `months_of_cover`
are pure and unit-tested directly, with no database, mirroring how
`domains.money.csv_import.parse_rows` is tested. `run_recurring_detection` /
`run_pay_period_detection` are integration-tested against the real kernel,
mirroring `domains.money.csv_import.import_csv`.
"""

from datetime import date
from uuid import UUID, uuid4

import pytest

from domains.money.common import account_key, money_context, normalize_description
from domains.money.csv_import import import_csv
from domains.money.recurring import (
    AMOUNT_ABS_FLOOR,
    METHOD,
    TxnRecord,
    analyze_series,
    detect_pay_periods,
    detect_recurring,
    list_review_queue,
    months_of_cover,
    run_pay_period_detection,
    run_recurring_detection,
)
from domains.money.types import (
    REASON_AMOUNT_VARIANCE,
    REASON_CADENCE_IRREGULAR,
    REASON_INSUFFICIENT_HISTORY,
    REASON_MISSING_PAYCHECKS,
    REASON_MULTIPLE_PAYCHECK_SERIES,
    STATUS_CONFIRMED,
    STATUS_REVIEW,
    define_money_types,
)
from kernel.access import AccessContext
from kernel.services import find

AK = account_key("csv", "checking")


def _txn(
    posted: date,
    amount: float,
    desc: str = "netflix",
    ak: str = AK,
    entity_id: UUID | None = None,
) -> TxnRecord:
    return TxnRecord(
        entity_id=entity_id or uuid4(),
        account_key=ak,
        posted_date=posted,
        amount=amount,
        normalized_desc=normalize_description(desc),
    )


# ---------------------------------------------------------------------------
# analyze_series / detect_recurring: pure unit tests
# ---------------------------------------------------------------------------


def test_clean_monthly_subscription_is_confirmed() -> None:
    records = [
        _txn(date(2026, 1, 15), -12.99),
        _txn(date(2026, 2, 15), -12.99),
        _txn(date(2026, 3, 15), -12.99),
        _txn(date(2026, 4, 14), -12.99),
    ]
    result = analyze_series(records)
    assert result is not None
    assert result.status == STATUS_CONFIRMED
    assert result.review_reason is None
    assert result.cadence_days == 30
    assert result.typical_amount == -12.99
    assert result.occurrence_count == 4


def test_noisy_merchant_within_tolerance_is_still_confirmed() -> None:
    """A merchant whose amount drifts a little (tax, tip, plan tier) but
    stays within tolerance is a recurring/noisy merchant that must classify
    correctly, not get bounced to review."""
    records = [
        _txn(date(2026, 1, 7), -50.00, "gym"),
        _txn(date(2026, 1, 14), -50.00, "gym"),
        _txn(date(2026, 1, 21), -52.00, "gym"),
        _txn(date(2026, 1, 28), -49.50, "gym"),
    ]
    result = analyze_series(records)
    assert result is not None
    assert result.status == STATUS_CONFIRMED
    assert result.cadence_days == 7


def test_amount_variance_past_tolerance_routes_to_review() -> None:
    """The borderline side of the ambiguity threshold: cadence is clean but
    the amount drifts too far to trust as "the same charge"."""
    records = [
        _txn(date(2026, 1, 7), -20.00, "variable co"),
        _txn(date(2026, 1, 14), -20.00, "variable co"),
        _txn(date(2026, 1, 21), -35.00, "variable co"),  # >15% and >$3 off median
        _txn(date(2026, 1, 28), -20.00, "variable co"),
    ]
    result = analyze_series(records)
    assert result is not None
    assert result.status == STATUS_REVIEW
    assert result.review_reason == REASON_AMOUNT_VARIANCE


def test_two_plausible_cadences_is_ambiguous_and_routes_to_review() -> None:
    """The other borderline side: alternating weekly/biweekly intervals give
    no single cadence bucket every interval agrees on."""
    records = [
        _txn(date(2026, 1, 1), -10.00, "mixed cadence"),
        _txn(date(2026, 1, 8), -10.00, "mixed cadence"),  # +7
        _txn(date(2026, 1, 22), -10.00, "mixed cadence"),  # +14
        _txn(date(2026, 1, 29), -10.00, "mixed cadence"),  # +7
    ]
    result = analyze_series(records)
    assert result is not None
    assert result.status == STATUS_REVIEW
    assert result.review_reason == REASON_CADENCE_IRREGULAR
    assert result.cadence_days is None


def test_an_interval_matching_no_bucket_is_cadence_irregular() -> None:
    records = [
        _txn(date(2026, 1, 1), -10.00, "odd gap"),
        _txn(date(2026, 1, 21), -10.00, "odd gap"),  # 20 days: no bucket within slack
        _txn(date(2026, 2, 10), -10.00, "odd gap"),  # 20 days again
    ]
    result = analyze_series(records)
    assert result is not None
    assert result.status == STATUS_REVIEW
    assert result.review_reason == REASON_CADENCE_IRREGULAR


def test_two_occurrences_is_insufficient_history() -> None:
    records = [
        _txn(date(2026, 1, 1), -10.00, "new merchant"),
        _txn(date(2026, 1, 8), -10.00, "new merchant"),
    ]
    result = analyze_series(records)
    assert result is not None
    assert result.status == STATUS_REVIEW
    assert result.review_reason == REASON_INSUFFICIENT_HISTORY
    assert result.cadence_days is None


def test_single_occurrence_carries_no_series_signal() -> None:
    result = analyze_series([_txn(date(2026, 1, 1), -10.00, "one-off")])
    assert result is None


def test_duplicate_transaction_records_are_deduped_not_double_counted() -> None:
    """Same entity handed to the detector twice (e.g. a caller reading the
    same page twice) must not manufacture a same-day interval of 0."""
    shared_id = uuid4()
    clean = [
        _txn(date(2026, 1, 7), -12.99, "dup co", entity_id=shared_id),
        _txn(date(2026, 2, 6), -12.99, "dup co"),
        _txn(date(2026, 3, 8), -12.99, "dup co"),
    ]
    duplicated = clean + [_txn(date(2026, 1, 7), -12.99, "dup co", entity_id=shared_id)]
    assert analyze_series(clean) == analyze_series(duplicated)
    assert analyze_series(duplicated).occurrence_count == 3  # type: ignore[union-attr]


def test_detect_recurring_groups_by_account_and_merchant_and_skips_singletons() -> None:
    other_ak = account_key("csv", "savings")
    records = [
        _txn(date(2026, 1, 1), -9.99, "spotify"),
        _txn(date(2026, 2, 1), -9.99, "spotify"),
        _txn(date(2026, 3, 1), -9.99, "spotify"),
        _txn(date(2026, 1, 5), -9.99, "spotify", ak=other_ak),  # different account: separate
        _txn(date(2026, 1, 10), -3.50, "coffee"),  # singleton: no signal
    ]
    results = detect_recurring(records)
    keys = {(r.account_key, r.normalized_desc) for r in results}
    assert (AK, normalize_description("spotify")) in keys
    assert (other_ak, normalize_description("spotify")) not in keys  # only 1 occurrence there
    assert (AK, normalize_description("coffee")) not in keys


def test_detect_recurring_is_deterministic_across_runs() -> None:
    records = [
        _txn(date(2026, 1, 1), -9.99, "spotify"),
        _txn(date(2026, 2, 1), -9.99, "spotify"),
        _txn(date(2026, 3, 1), -9.99, "spotify"),
    ]
    assert detect_recurring(records) == detect_recurring(list(reversed(records)))


# ---------------------------------------------------------------------------
# detect_pay_periods: pure unit tests
# ---------------------------------------------------------------------------


def _paycheck(posted: date, ak: str = AK) -> TxnRecord:
    return _txn(posted, 1500.00, "acme payroll", ak=ak)


def test_regular_biweekly_paychecks_produce_windows() -> None:
    records = [
        _paycheck(date(2026, 1, 2)),
        _paycheck(date(2026, 1, 16)),
        _paycheck(date(2026, 1, 30)),
        _paycheck(date(2026, 2, 13)),
    ]
    (result,) = detect_pay_periods(records)
    assert result.reason is None
    assert len(result.periods) == 4
    first, second, third, last = result.periods
    assert first.start_date == date(2026, 1, 2)
    assert first.end_date == date(2026, 1, 15)  # day before the next deposit
    assert first.closed is True
    assert last.start_date == date(2026, 2, 13)
    assert last.end_date == date(2026, 2, 26)  # start + (cadence_days - 1)
    assert last.closed is False  # still open: no next deposit yet


def test_missing_paychecks_produces_no_periods() -> None:
    records = [
        _txn(date(2026, 1, 5), -12.99, "netflix"),
        _txn(date(2026, 2, 5), -12.99, "netflix"),
        _txn(date(2026, 3, 5), -12.99, "netflix"),
    ]
    (result,) = detect_pay_periods(records)
    assert result.reason == REASON_MISSING_PAYCHECKS
    assert result.periods == ()


def test_irregular_pay_cadence_produces_no_fabricated_periods() -> None:
    """An irregular deposit cadence never confirms, so it must never be
    silently promoted into a pay-period fact."""
    records = [
        _paycheck(date(2026, 1, 1)),
        _paycheck(date(2026, 1, 8)),
        _paycheck(date(2026, 1, 25)),
        _paycheck(date(2026, 2, 1)),
    ]
    (result,) = detect_pay_periods(records)
    assert result.periods == ()
    assert result.reason == REASON_MISSING_PAYCHECKS  # never confirmed -> nothing to build from


def test_multiple_plausible_paycheck_series_is_ambiguous() -> None:
    records = [
        _paycheck(date(2026, 1, 2)),
        _paycheck(date(2026, 1, 16)),
        _paycheck(date(2026, 1, 30)),
        _txn(date(2026, 1, 5), 800.00, "side gig", ak=AK),
        _txn(date(2026, 2, 5), 800.00, "side gig", ak=AK),
        _txn(date(2026, 3, 5), 800.00, "side gig", ak=AK),
    ]
    (result,) = detect_pay_periods(records)
    assert result.reason == REASON_MULTIPLE_PAYCHECK_SERIES
    assert result.periods == ()


def test_pay_periods_are_per_account() -> None:
    other_ak = account_key("csv", "joint")
    records = [
        _paycheck(date(2026, 1, 2)),
        _paycheck(date(2026, 1, 16)),
        _paycheck(date(2026, 1, 30)),
        _paycheck(date(2026, 1, 3), ak=other_ak),
        _paycheck(date(2026, 1, 17), ak=other_ak),
        _paycheck(date(2026, 1, 31), ak=other_ak),
    ]
    results = {r.account_key: r for r in detect_pay_periods(records)}
    assert results[AK].reason is None
    assert results[other_ak].reason is None
    assert len(results[AK].periods) == 3
    assert len(results[other_ak].periods) == 3


# ---------------------------------------------------------------------------
# months_of_cover: pure unit tests
# ---------------------------------------------------------------------------


def test_months_of_cover_divides_balance_by_baseline() -> None:
    assert months_of_cover(9000.0, 3000.0) == 3.0


def test_months_of_cover_is_none_for_a_zero_baseline() -> None:
    assert months_of_cover(9000.0, 0.0) is None


def test_months_of_cover_is_none_for_a_negative_baseline() -> None:
    assert months_of_cover(9000.0, -100.0) is None


def test_months_of_cover_is_none_for_a_negative_balance() -> None:
    assert months_of_cover(-1.0, 3000.0) is None


def test_amount_abs_floor_is_positive() -> None:
    # Sanity guard on the constant the amount-variance test above relies on.
    assert AMOUNT_ABS_FLOOR > 0


# ---------------------------------------------------------------------------
# run_recurring_detection / run_pay_period_detection: integration against the kernel
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def money_ctx(clean_database: None) -> AccessContext:
    ctx = money_context()
    define_money_types(ctx)
    return ctx


def _seed(ctx: AccessContext, csv_text: str, account_label: str) -> None:
    import_csv(ctx, csv_text.encode(), account_label)


def test_run_recurring_detection_writes_confirmed_and_review_records(
    money_ctx: AccessContext,
) -> None:
    csv_text = (
        "date,amount,description\n"
        "2026-01-01,-12.99,HULU\n"
        "2026-02-01,-12.99,HULU\n"
        "2026-03-01,-12.99,HULU\n"
        "2026-01-05,-8.00,RANDOM SHOP ONE\n"  # singleton across account
    )
    _seed(money_ctx, csv_text, "Recurring Test Account")
    report = run_recurring_detection(money_ctx)
    assert report.confirmed >= 1

    ak = account_key("csv", "Recurring Test Account")
    (charge,) = find(
        money_ctx,
        type_name="recurring_charge",
        filters={"account_key": ak, "normalized_desc": "hulu"},
    )
    assert charge.attributes["status"] == STATUS_CONFIRMED
    assert charge.attributes["cadence_days"] == 30
    assert charge.attributes["provenance"]["method"] == METHOD
    assert charge.attributes["provenance"]["confidence"] == 1.0
    assert len(charge.attributes["provenance"]["source_entity_ids"]) == 3


def test_rerunning_detection_over_unchanged_data_emits_nothing_new(
    money_ctx: AccessContext,
) -> None:
    csv_text = (
        "date,amount,description\n"
        "2026-01-02,-15.00,STABLE CO\n"
        "2026-02-02,-15.00,STABLE CO\n"
        "2026-03-02,-15.00,STABLE CO\n"
    )
    _seed(money_ctx, csv_text, "Idempotency Test Account")
    first = run_recurring_detection(money_ctx)
    assert first.created >= 1 or first.updated >= 1

    second = run_recurring_detection(money_ctx)
    assert second.created == 0
    assert second.updated == 0


def test_review_queue_lists_only_review_status_charges(money_ctx: AccessContext) -> None:
    csv_text = (
        "date,amount,description\n"
        "2026-01-01,-20.00,AMBIGUOUS AMOUNT CO\n"
        "2026-01-08,-20.00,AMBIGUOUS AMOUNT CO\n"
        "2026-01-15,-35.00,AMBIGUOUS AMOUNT CO\n"
        "2026-01-22,-20.00,AMBIGUOUS AMOUNT CO\n"
    )
    _seed(money_ctx, csv_text, "Review Queue Account")
    run_recurring_detection(money_ctx)

    queue = list_review_queue(money_ctx)
    assert queue  # never empty in this test: the seeded series is genuinely ambiguous
    assert all(entity.attributes["status"] == STATUS_REVIEW for entity in queue)
    ak = account_key("csv", "Review Queue Account")
    matching = [e for e in queue if e.attributes.get("account_key") == ak]
    assert matching
    assert matching[0].attributes["review_reason"] == REASON_AMOUNT_VARIANCE
    assert matching[0].attributes["provenance"]["confidence"] < 1.0
    assert "cadence_days" not in matching[0].attributes


def test_run_pay_period_detection_writes_windows_from_confirmed_paychecks(
    money_ctx: AccessContext,
) -> None:
    csv_text = (
        "date,amount,description\n"
        "2026-01-02,1500.00,ACME PAYROLL\n"
        "2026-01-16,1500.00,ACME PAYROLL\n"
        "2026-01-30,1500.00,ACME PAYROLL\n"
    )
    _seed(money_ctx, csv_text, "Pay Period Test Account")
    run_recurring_detection(money_ctx)
    report = run_pay_period_detection(money_ctx)
    assert report.periods_written >= 3

    ak = account_key("csv", "Pay Period Test Account")
    periods = find(money_ctx, type_name="pay_period", filters={"account_key": ak})
    assert len(periods) == 3
    closed = sorted(p.attributes["start_date"] for p in periods if p.attributes["closed"])
    assert closed == ["2026-01-02", "2026-01-16"]
    (open_period,) = [p for p in periods if not p.attributes["closed"]]
    assert open_period.attributes["start_date"] == "2026-01-30"


def test_pay_period_detection_writes_nothing_when_paychecks_are_missing(
    money_ctx: AccessContext,
) -> None:
    csv_text = (
        "date,amount,description\n"
        "2026-01-01,-12.99,LONE SUBSCRIPTION\n"
        "2026-02-01,-12.99,LONE SUBSCRIPTION\n"
        "2026-03-01,-12.99,LONE SUBSCRIPTION\n"
    )
    _seed(money_ctx, csv_text, "No Paycheck Account")
    run_recurring_detection(money_ctx)
    report = run_pay_period_detection(money_ctx)

    ak = account_key("csv", "No Paycheck Account")
    periods = find(money_ctx, type_name="pay_period", filters={"account_key": ak})
    assert periods == []
    assert report.accounts_missing_paychecks >= 1


def test_erasure_of_a_transaction_survives_a_recurring_rerun(money_ctx: AccessContext) -> None:
    """An erased transaction (forget()) has no amount/description left, so it
    must drop out of detection input rather than crash or fabricate a value."""
    from kernel.services import forget

    csv_text = (
        "date,amount,description\n"
        "2026-01-01,-19.99,ERASE SERIES\n"
        "2026-02-01,-19.99,ERASE SERIES\n"
        "2026-03-01,-19.99,ERASE SERIES\n"
    )
    _seed(money_ctx, csv_text, "Erase Recurring Account")
    # All three rows share normalized_desc "erase series" (it's a recurring
    # series, by design), so pick the specific one to erase by its own
    # identifying date rather than assuming find() returns exactly one match.
    (txn,) = [
        e
        for e in find(
            money_ctx, type_name="transaction", filters={"normalized_desc": "erase series"}
        )
        if e.attributes.get("posted_date") == "2026-01-01"
    ]
    forget(money_ctx, txn.id, fields=["amount", "description", "normalized_desc"])

    # Must not raise, and must not crash on the erased row.
    run_recurring_detection(money_ctx)


def test_run_recurring_detection_job_exits_ok(money_ctx: AccessContext) -> None:
    from domains.money.recurring import main

    assert main([]) == 0
