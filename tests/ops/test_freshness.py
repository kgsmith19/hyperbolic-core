"""Source-freshness ledger (issue #90).

`classify` is pure logic and is tested directly with no ctx and no database
(unit tier). `compute_ledger` reads real `execution_receipt` / `source_receipt`
/ `weight_measurement` rows and is tested against Postgres (integration tier),
mirroring the split `domains.ops.briefing` already uses between `assemble`
(pure-ish composition over reads) and its own kernel-backed fixtures.

Integration fixtures below are dated in 2033 so this module's own receipts
always sort as the *latest* run for their job/type, regardless of whatever
real (present-day) calendar/health_connect fixtures other test modules leave
behind in the same shared test database.
"""

from datetime import UTC, datetime, timedelta
from hashlib import sha256

import pytest

from domains.calendar.ingest import METHOD as CALENDAR_INGEST_JOB
from domains.calendar.types import define_calendar_types
from domains.health_connect.types import define_health_connect_types
from domains.ops.freshness import (
    FRESHNESS_THRESHOLDS,
    SOURCE_CALENDAR,
    SOURCE_HEALTH_CONNECT,
    STATE_FRESH,
    STATE_NEVER_SEEN,
    STATE_STALE,
    STATE_UNAVAILABLE,
    SourceFreshness,
    classify,
    compute_ledger,
    ledger_context,
)
from domains.ops.receipts import STATUS_FAILED, STATUS_OK, STATUS_SKIPPED
from domains.ops.types import define_ops_types
from kernel.access import AccessContext, ScopeError
from kernel.services import capture

NOW = datetime(2033, 6, 15, 12, 0, tzinfo=UTC)
THRESHOLD = timedelta(hours=6)

# ---------------------------------------------------------------------------
# Unit: classify is pure -- no ctx, no database.
# ---------------------------------------------------------------------------


def test_never_seen_when_no_success_is_on_record() -> None:
    assert classify(NOW, THRESHOLD, None, None, None) == STATE_NEVER_SEEN


def test_never_seen_even_with_an_attempt_and_failure_on_record() -> None:
    # A missing/failed source must never fabricate green, but it must also
    # never claim more than it knows: no success ever recorded is
    # never_seen, not "unavailable", regardless of attempt history.
    assert classify(NOW, THRESHOLD, None, NOW, STATUS_FAILED) == STATE_NEVER_SEEN


def test_fresh_within_threshold() -> None:
    last_success = NOW - timedelta(hours=1)
    assert classify(NOW, THRESHOLD, last_success, last_success, None) == STATE_FRESH


def test_stale_past_threshold() -> None:
    last_success = NOW - timedelta(hours=7)
    assert classify(NOW, THRESHOLD, last_success, last_success, None) == STATE_STALE


def test_clock_boundary_is_inclusive_of_fresh() -> None:
    exactly_at_threshold = NOW - THRESHOLD
    assert (
        classify(NOW, THRESHOLD, exactly_at_threshold, exactly_at_threshold, None) == STATE_FRESH
    )
    one_tick_over = exactly_at_threshold - timedelta(microseconds=1)
    assert classify(NOW, THRESHOLD, one_tick_over, one_tick_over, None) == STATE_STALE


def test_failed_latest_attempt_is_unavailable_even_if_an_earlier_success_was_fresh() -> None:
    last_success = NOW - timedelta(minutes=5)
    last_attempt = NOW - timedelta(minutes=1)  # a later attempt that failed
    assert (
        classify(NOW, THRESHOLD, last_success, last_attempt, STATUS_FAILED) == STATE_UNAVAILABLE
    )
    assert (
        classify(NOW, THRESHOLD, last_success, last_attempt, STATUS_SKIPPED) == STATE_UNAVAILABLE
    )


def test_recovered_source_returns_to_fresh_once_the_latest_attempt_is_clean() -> None:
    # The caller clears last_failure_class once the latest attempt is `ok`
    # (see _calendar_freshness) -- classify only ever sees the clean state.
    last_success = NOW - timedelta(minutes=1)
    assert classify(NOW, THRESHOLD, last_success, last_success, None) == STATE_FRESH


def test_state_vocabulary_matches_the_issue() -> None:
    assert {STATE_NEVER_SEEN, STATE_FRESH, STATE_STALE, STATE_UNAVAILABLE} == {
        "never_seen",
        "fresh",
        "stale",
        "unavailable",
    }


# ---------------------------------------------------------------------------
# Integration: compute_ledger reads real kernel receipts/entities.
# ---------------------------------------------------------------------------

BASE = datetime(2033, 1, 1, tzinfo=UTC)


@pytest.fixture(scope="module")
def fresh_ctx(ctx: AccessContext) -> AccessContext:
    """The exact production context (read-only): used to exercise
    `compute_ledger` itself, never to seed fixture data."""
    define_ops_types(ctx)
    define_calendar_types(ctx)
    define_health_connect_types(ctx)
    return ledger_context()


@pytest.fixture(scope="module")
def seed_ctx(fresh_ctx: AccessContext) -> AccessContext:
    """Write scopes for arranging fixture data only -- `compute_ledger`
    itself is always exercised through the read-only `fresh_ctx` above, so
    this fixture never touches the ledger query."""
    return AccessContext.of(
        "ops:read",
        "ops:write",
        "calendar:read",
        "calendar:write",
        "health_connect:read",
        "health_connect:write",
    )


def make_receipt(ctx: AccessContext, at: datetime, status: str) -> None:
    capture(
        ctx,
        "execution_receipt",
        {
            "job": CALENDAR_INGEST_JOB,
            "started_at": at.isoformat(),
            "finished_at": at.isoformat(),
            "status": status,
        },
        actor=CALENDAR_INGEST_JOB,
    )


def make_source_receipt(ctx: AccessContext, key: str, fetched_at: datetime) -> None:
    capture(
        ctx,
        "source_receipt",
        {
            "receipt_key": key,
            "sha256": "0" * 64,
            "url_hash": "1" * 64,
            "source_host": "freshness.fixture.test",
            "fetched_at": fetched_at.isoformat(),
            "size_bytes": 10,
        },
        actor=CALENDAR_INGEST_JOB,
    )


def make_weight(ctx: AccessContext, time: datetime, kilograms: float) -> None:
    capture(
        ctx,
        "weight_measurement",
        {
            "content_hash": sha256(f"weight:{time.isoformat()}:{kilograms}".encode()).hexdigest(),
            "kilograms": kilograms,
            "time": time.isoformat(),
            "source": "health_connect",
        },
    )


def by_source(ledger: list[SourceFreshness]) -> dict[str, SourceFreshness]:
    return {r.source_id: r for r in ledger}


def test_calendar_source_reads_fresh_after_a_successful_run(
    fresh_ctx: AccessContext, seed_ctx: AccessContext
) -> None:
    ran_at = BASE + timedelta(days=1)
    make_receipt(seed_ctx, ran_at, STATUS_OK)
    make_source_receipt(seed_ctx, "freshness-key-1", ran_at)

    ledger = by_source(compute_ledger(fresh_ctx, now=ran_at + timedelta(hours=1)))

    record = ledger[SOURCE_CALENDAR]
    assert record.state == STATE_FRESH
    assert record.last_success_at == ran_at
    assert record.newest_observed_at == ran_at
    assert record.last_attempt_at == ran_at
    assert record.last_failure_class is None


def test_calendar_source_reads_stale_once_past_its_threshold(fresh_ctx: AccessContext) -> None:
    threshold = FRESHNESS_THRESHOLDS[SOURCE_CALENDAR]
    later_now = BASE + timedelta(days=1) + threshold + timedelta(minutes=1)

    record = by_source(compute_ledger(fresh_ctx, now=later_now))[SOURCE_CALENDAR]

    assert record.state == STATE_STALE


def test_calendar_source_reads_unavailable_after_a_failed_latest_attempt(
    fresh_ctx: AccessContext, seed_ctx: AccessContext
) -> None:
    failed_at = BASE + timedelta(days=2)
    make_receipt(seed_ctx, failed_at, STATUS_FAILED)

    record = by_source(
        compute_ledger(fresh_ctx, now=failed_at + timedelta(minutes=1))
    )[SOURCE_CALENDAR]

    assert record.state == STATE_UNAVAILABLE
    assert record.last_failure_class == STATUS_FAILED
    assert record.last_success_at == BASE + timedelta(days=1)  # the earlier success lingers


def test_calendar_source_recovers_once_a_later_attempt_succeeds(
    fresh_ctx: AccessContext, seed_ctx: AccessContext
) -> None:
    recovered_at = BASE + timedelta(days=3)
    make_receipt(seed_ctx, recovered_at, STATUS_OK)

    record = by_source(
        compute_ledger(fresh_ctx, now=recovered_at + timedelta(minutes=1))
    )[SOURCE_CALENDAR]

    assert record.state == STATE_FRESH
    assert record.last_failure_class is None
    assert record.last_success_at == recovered_at


def test_health_connect_source_has_no_attempt_tracking(
    fresh_ctx: AccessContext, seed_ctx: AccessContext
) -> None:
    reading_at = BASE + timedelta(days=10)
    make_weight(seed_ctx, reading_at, 80.0)

    record = by_source(
        compute_ledger(fresh_ctx, now=reading_at + timedelta(hours=1))
    )[SOURCE_HEALTH_CONNECT]

    assert record.state == STATE_FRESH
    assert record.last_attempt_at is None and record.last_failure_class is None
    assert record.newest_observed_at == reading_at


def test_ledger_context_is_read_only() -> None:
    scopes = ledger_context().scopes
    assert scopes == {"ops:read", "calendar:read", "health_connect:read"}


def test_ledger_surfaces_no_secrets_or_raw_payloads(fresh_ctx: AccessContext) -> None:
    ledger = compute_ledger(fresh_ctx, now=BASE + timedelta(days=20))
    body = str(ledger)
    assert "freshness.fixture.test" not in body  # source_host never leaves source_receipt
    assert "80.0" not in body  # no raw measurement value ever surfaces


def test_ledger_refuses_without_read_scope() -> None:
    with pytest.raises(ScopeError):
        compute_ledger(AccessContext.of("ops:read"), now=BASE)
