"""Health Connect ingestion tests.

Exercises process_payload against the real kernel via the mock Withings payload,
and the POST /health-connect endpoint via the FastAPI test client.
"""

import copy
import os
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from api.main import app
from domains.health_connect.ingest import MOCK_PAYLOAD, IngestResult, process_payload
from domains.health_connect.types import define_health_connect_types
from kernel import services
from kernel.access import AccessContext

client = TestClient(app)


@pytest.fixture(scope="module")
def hc_ctx(clean_database: None) -> AccessContext:
    ctx = AccessContext.of("health_connect:read", "health_connect:write")
    define_health_connect_types(ctx)
    return ctx


# ---------------------------------------------------------------------------
# process_payload unit / integration
# ---------------------------------------------------------------------------


def test_mock_payload_ingests_weight_and_activity(hc_ctx: AccessContext) -> None:
    result = process_payload(hc_ctx, copy.deepcopy(MOCK_PAYLOAD))
    assert isinstance(result, IngestResult)
    assert result.weight_ingested == 1
    assert result.activity_ingested == 1
    assert result.errors == []


def test_replay_same_payload_is_idempotent(hc_ctx: AccessContext) -> None:
    """Replaying the identical window must emit zero new events (content-hash merge)."""
    r1 = process_payload(hc_ctx, copy.deepcopy(MOCK_PAYLOAD))
    r2 = process_payload(hc_ctx, copy.deepcopy(MOCK_PAYLOAD))
    assert r1.weight_ingested == r2.weight_ingested
    assert r1.activity_ingested == r2.activity_ingested

    weights = services.find(hc_ctx, type_name="weight_measurement")
    assert sum(1 for w in weights if w.attributes["source"] == "health_connect") >= 1


def test_weight_only_payload(hc_ctx: AccessContext) -> None:
    payload: dict = {
        "timestamp": "2026-08-09T06:00:00+00:00",
        "app_version": "1.0.4",
        "weight": [{"kilograms": 83.0, "time": "2026-08-09T05:58:00+00:00"}],
    }
    result = process_payload(hc_ctx, payload)
    assert result.weight_ingested == 1
    assert result.activity_ingested == 0


def test_activity_only_payload(hc_ctx: AccessContext) -> None:
    payload: dict = {
        "timestamp": "2026-08-09T07:00:00+00:00",
        "app_version": "1.0.4",
        "exercise": [
            {
                "type": "RUNNING",
                "start_time": "2026-08-09T06:00:00+00:00",
                "end_time": "2026-08-09T06:30:00+00:00",
                "duration_seconds": 1800,
                "distance_meters": 5000.0,
                "steps": 4400,
            }
        ],
    }
    result = process_payload(hc_ctx, payload)
    assert result.weight_ingested == 0
    assert result.activity_ingested == 1


def test_unknown_top_level_array_is_ignored(hc_ctx: AccessContext) -> None:
    payload: dict = {
        "timestamp": "2026-08-10T06:00:00+00:00",
        "app_version": "1.0.4",
        "sleep": [{"start": "2026-08-10T22:00:00+00:00"}],  # unknown, ignored
    }
    result = process_payload(hc_ctx, payload)
    assert result.errors == []
    assert result.weight_ingested == 0
    assert result.activity_ingested == 0


def test_unknown_field_in_weight_produces_error(hc_ctx: AccessContext) -> None:
    payload: dict = {
        "timestamp": "2026-08-10T06:00:00+00:00",
        "app_version": "1.0.4",
        "weight": [{"kilograms": 83.0, "time": "2026-08-10T05:58:00+00:00", "unit": "kg"}],
    }
    result = process_payload(hc_ctx, payload)
    assert result.weight_ingested == 0
    assert any("unknown weight fields" in e for e in result.errors)


def test_missing_required_exercise_field_produces_error(hc_ctx: AccessContext) -> None:
    payload: dict = {
        "timestamp": "2026-08-10T07:00:00+00:00",
        "app_version": "1.0.4",
        "exercise": [{"type": "WALKING", "start_time": "2026-08-10T06:00:00+00:00"}],
    }
    result = process_payload(hc_ctx, payload)
    assert result.activity_ingested == 0
    assert any("duration_seconds" in e for e in result.errors)


# ---------------------------------------------------------------------------
# POST /health-connect API route
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def auth_hc() -> Iterator[None]:
    """Set auth to disabled AND set a dummy HC secret for the route tests."""
    prev_auth = os.environ.get("LIFEOS_AUTH_MODE")
    prev_secret = os.environ.get("LIFEOS_HC_SECRET")
    os.environ["LIFEOS_AUTH_MODE"] = "disabled"
    os.environ["LIFEOS_HC_SECRET"] = "test-secret"
    yield
    if prev_auth is None:
        os.environ.pop("LIFEOS_AUTH_MODE", None)
    else:
        os.environ["LIFEOS_AUTH_MODE"] = prev_auth
    if prev_secret is None:
        os.environ.pop("LIFEOS_HC_SECRET", None)
    else:
        os.environ["LIFEOS_HC_SECRET"] = prev_secret


def test_post_health_connect_accepts_mock_payload(auth_hc: None) -> None:
    response = client.post(
        "/health-connect",
        json=MOCK_PAYLOAD,
        headers={"X-HC-Secret": "test-secret"},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["weight_ingested"] >= 1
    assert data["activity_ingested"] >= 1


def test_post_health_connect_rejects_wrong_secret(auth_hc: None) -> None:
    response = client.post(
        "/health-connect",
        json=MOCK_PAYLOAD,
        headers={"X-HC-Secret": "wrong"},
    )
    assert response.status_code == 401


def test_post_health_connect_rejects_missing_header(auth_hc: None) -> None:
    response = client.post("/health-connect", json=MOCK_PAYLOAD)
    assert response.status_code == 401


def test_post_health_connect_fails_closed_when_server_secret_missing() -> None:
    prev_auth = os.environ.get("LIFEOS_AUTH_MODE")
    prev_secret = os.environ.pop("LIFEOS_HC_SECRET", None)
    os.environ["LIFEOS_AUTH_MODE"] = "disabled"
    try:
        response = client.post(
            "/health-connect",
            json=MOCK_PAYLOAD,
            headers={"X-HC-Secret": "anything"},
        )
    finally:
        if prev_auth is None:
            os.environ.pop("LIFEOS_AUTH_MODE", None)
        else:
            os.environ["LIFEOS_AUTH_MODE"] = prev_auth
        if prev_secret is not None:
            os.environ["LIFEOS_HC_SECRET"] = prev_secret
    assert response.status_code == 503


def test_post_health_connect_empty_payload(auth_hc: None) -> None:
    response = client.post(
        "/health-connect",
        json={"timestamp": "2026-08-08T10:00:00+00:00", "app_version": "1.0.4"},
        headers={"X-HC-Secret": "test-secret"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["weight_ingested"] == 0
    assert data["activity_ingested"] == 0
