"""CPAP ingestion tests (roadmap H2).

`parse_night` is pure and unit-tested directly; `ingest_nights` and the
scheduled job (`main`) are integration-tested against the real kernel,
mirroring `domains.calendar.ingest`'s idempotency and durable-erasure proofs.
"""

import os
from collections.abc import Iterator
from datetime import UTC, date, datetime
from typing import Any

import pytest

from domains.cpap.ingest import (
    DERIVED_FROM,
    METHOD,
    ParsedNight,
    cpap_context,
    ingest_nights,
    main,
    parse_night,
    sleephq_credentials,
)
from domains.cpap.sleephq_client import SleepHQError
from domains.cpap.types import define_cpap_types
from kernel.access import AccessContext
from kernel.services import find, forget, get_entity, redacted_fields
from tests.support import event_count

WINDOW_START = date(2026, 8, 1)
WINDOW_END = date(2026, 8, 5)


def night(day: str, total_time: float = 25200, **extra: Any) -> dict[str, Any]:
    attributes = {"date": day, "total_time": total_time, **extra}
    return {"id": day, "type": "night", "attributes": attributes}


# ---------------------------------------------------------------------------
# parse_night: pure unit tests
# ---------------------------------------------------------------------------


def test_parse_night_extracts_all_fields() -> None:
    raw = night("2026-08-01", ahi=2.1, leak_95=12.4, pressure_95=9.8, central_ahi=0.3)
    parsed = parse_night(raw)
    assert parsed == ParsedNight(
        session_date=date(2026, 8, 1),
        usage_min=420,
        ahi=2.1,
        leak_95p=12.4,
        pressure_95p=9.8,
        central_ahi=0.3,
    )


def test_parse_night_missing_optional_fields_are_none() -> None:
    parsed = parse_night(night("2026-08-01"))
    assert parsed is not None
    assert parsed.ahi is None and parsed.leak_95p is None
    assert parsed.pressure_95p is None and parsed.central_ahi is None


@pytest.mark.parametrize(
    "raw",
    [
        "not a dict",
        {},
        {"attributes": "not a dict"},
        {"attributes": {"total_time": 100}},  # missing date
        {"attributes": {"date": "not-a-date", "total_time": 100}},
        {"attributes": {"date": "2026-08-01"}},  # missing total_time
        {"attributes": {"date": "2026-08-01", "total_time": "seven hours"}},
        {"attributes": {"date": "2026-08-01", "total_time": -1}},
        {"attributes": {"date": "2026-08-01", "total_time": True}},  # bool, not a real number
        {"attributes": {"date": "2026-08-01", "total_time": 100000}},  # > 24h of usage
    ],
)
def test_parse_night_drops_malformed_input_instead_of_guessing(raw: Any) -> None:
    assert parse_night(raw) is None


def test_parse_night_accepts_usage_exactly_at_twenty_four_hours() -> None:
    parsed = parse_night(night("2026-08-01", total_time=24 * 60 * 60))
    assert parsed is not None
    assert parsed.usage_min == 24 * 60


def test_parse_night_drops_non_numeric_optional_field() -> None:
    parsed = parse_night(night("2026-08-01", ahi="high"))
    assert parsed is not None
    assert parsed.ahi is None


# ---------------------------------------------------------------------------
# ingest_nights: integration against the kernel
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def cpap_ctx(clean_database: None) -> AccessContext:
    ctx = cpap_context()
    define_cpap_types(ctx)
    return ctx


def test_ingest_creates_sessions_linked_to_a_receipt(cpap_ctx: AccessContext) -> None:
    raw = [night("2026-08-01", ahi=2.1), night("2026-08-02")]
    report = ingest_nights(cpap_ctx, raw, WINDOW_START, WINDOW_END)

    assert report.created == 2 and report.updated == 0 and report.skipped == 0
    assert not report.unchanged and report.receipt_id is not None

    receipt = get_entity(cpap_ctx, report.receipt_id)
    assert "cpap_source_receipt" in receipt.types
    assert receipt.entity.attributes["session_count"] == 2
    assert receipt.entity.attributes["source"] == "sleephq"

    (session,) = find(cpap_ctx, type_name="cpap_session", filters={"session_date": "2026-08-01"})
    assert session.attributes["usage_min"] == 420
    assert session.attributes["ahi"] == 2.1

    edges = get_entity(cpap_ctx, session.id).edges_out
    derived = [e for e in edges if e.relation == DERIVED_FROM]
    assert derived and derived[0].to_entity == report.receipt_id
    assert derived[0].attributes["method"] == METHOD
    assert derived[0].attributes["confidence"] == 1.0


def test_replaying_the_identical_response_emits_nothing(cpap_ctx: AccessContext) -> None:
    raw = [night("2026-08-03")]
    first = ingest_nights(cpap_ctx, raw, WINDOW_START, WINDOW_END)
    assert not first.unchanged

    before = event_count()
    second = ingest_nights(cpap_ctx, raw, WINDOW_START, WINDOW_END)
    assert second.unchanged
    assert second.receipt_id == first.receipt_id
    assert event_count() == before  # the idempotency proof


def test_changed_response_only_recaptures_the_night_that_changed(
    cpap_ctx: AccessContext,
) -> None:
    first = ingest_nights(
        cpap_ctx,
        [night("2026-08-04", ahi=1.0), night("2026-08-05", ahi=1.0)],
        WINDOW_START,
        WINDOW_END,
    )
    assert first.created == 2

    second = ingest_nights(
        cpap_ctx,
        [night("2026-08-04", ahi=1.0), night("2026-08-05", ahi=5.0)],  # only 08-05 changed
        WINDOW_START,
        WINDOW_END,
    )
    assert not second.unchanged
    assert second.created == 0
    assert second.updated == 1  # only the changed night re-captured


def test_malformed_items_are_skipped_and_counted(cpap_ctx: AccessContext) -> None:
    raw = [night("2026-08-01"), {"attributes": {"date": "bad"}}, night("2026-08-01")]  # dup + bad
    report = ingest_nights(cpap_ctx, raw, WINDOW_START, WINDOW_END)
    assert report.skipped >= 2  # the malformed item plus the duplicate date


def test_erasure_survives_a_replay(cpap_ctx: AccessContext) -> None:
    raw = [night("2026-08-01", ahi=9.9)]
    ingest_nights(cpap_ctx, raw, WINDOW_START, WINDOW_END)
    (session,) = find(cpap_ctx, type_name="cpap_session", filters={"session_date": "2026-08-01"})

    forget(cpap_ctx, session.id, fields=["ahi", "usage_min"])
    assert redacted_fields(cpap_ctx, session.id) >= {"ahi", "usage_min"}

    # A later pull that still reports the same values must not write them back.
    ingest_nights(cpap_ctx, raw, WINDOW_START, WINDOW_END, fetched_at=datetime.now(UTC))
    (still_erased,) = find(
        cpap_ctx, type_name="cpap_session", filters={"session_date": "2026-08-01"}
    )
    assert "ahi" not in still_erased.attributes
    assert "usage_min" not in still_erased.attributes


# ---------------------------------------------------------------------------
# The scheduled job: credential-missing skip, failure, and success paths
# ---------------------------------------------------------------------------


@pytest.fixture
def clear_sleephq_env() -> Iterator[None]:
    keys = ["LIFEOS_SLEEPHQ_CLIENT_ID", "LIFEOS_SLEEPHQ_CLIENT_SECRET", "LIFEOS_SLEEPHQ_BASE_URL"]
    saved = {k: os.environ.pop(k, None) for k in keys}
    yield
    for k, v in saved.items():
        if v is not None:
            os.environ[k] = v
        else:
            os.environ.pop(k, None)


def test_sleephq_credentials_is_none_when_either_var_is_unset(clear_sleephq_env: None) -> None:
    assert sleephq_credentials() is None
    os.environ["LIFEOS_SLEEPHQ_CLIENT_ID"] = "id-only"
    assert sleephq_credentials() is None


def test_job_skips_with_no_credentials(clear_sleephq_env: None, cpap_ctx: AccessContext) -> None:
    assert main() == 1  # skipped is a non-zero exit (ADR 014: not a quiet no-op)
    receipts = find(cpap_ctx, type_name="execution_receipt", filters={"job": METHOD})
    assert receipts and receipts[-1].attributes["status"] == "skipped"


def test_job_reports_failed_when_sleephq_errors(
    clear_sleephq_env: None, cpap_ctx: AccessContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    os.environ["LIFEOS_SLEEPHQ_CLIENT_ID"] = "id"
    os.environ["LIFEOS_SLEEPHQ_CLIENT_SECRET"] = "secret"

    def boom(*args: Any, **kwargs: Any) -> Any:
        raise SleepHQError("token response carried no access_token")

    monkeypatch.setattr("domains.cpap.ingest.fetch_access_token", boom)

    assert main() == 1
    receipts = find(cpap_ctx, type_name="execution_receipt", filters={"job": METHOD})
    assert receipts and receipts[-1].attributes["status"] == "failed"


def test_job_succeeds_and_ingests_when_sleephq_responds(
    clear_sleephq_env: None, cpap_ctx: AccessContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    os.environ["LIFEOS_SLEEPHQ_CLIENT_ID"] = "id"
    os.environ["LIFEOS_SLEEPHQ_CLIENT_SECRET"] = "secret"

    monkeypatch.setattr("domains.cpap.ingest.fetch_access_token", lambda *a, **k: "tok")
    monkeypatch.setattr("domains.cpap.ingest.fetch_team_id", lambda *a, **k: "42")
    monkeypatch.setattr(
        "domains.cpap.ingest.fetch_nights", lambda *a, **k: [night("2026-08-01", ahi=1.5)]
    )

    assert main() == 0
    receipts = find(cpap_ctx, type_name="execution_receipt", filters={"job": METHOD})
    assert receipts and receipts[-1].attributes["status"] == "ok"
