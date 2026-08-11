"""Health Connect webhook payload handler (H1).

Receives ONE JSON delivery from the Health Connect Webhook Android app
(mcnaveen/health-connect-webhook). The app reads Google Health Connect on-device
and POSTs to this endpoint. A Withings scale is the weight source: it writes to
Health Connect via the Withings Health Mate app → Google Health Connect sync.

Idempotency is the core contract, not a defence. The app carries NO per-record id,
reads a rolling 48-hour window, and retries failed deliveries with backoff — duplicate
and overlapping delivery is the NORMAL case. Each record is keyed by a content hash
of (metric, timestamp, value); capture() with x-identity merges silently on replay.

Payload shape (one object per delivery):
    {
        "timestamp": "<ISO datetime>",
        "app_version": "<string>",
        "weight": [{"kilograms": <float>, "time": "<ISO datetime>"}, ...],
        "exercise": [{"type": "<string>", "start_time": "...", "end_time": "...",
                      "duration_seconds": <int>, ...optional fields...}, ...]
    }

Unknown TOP-LEVEL arrays are ignored (forward compatibility). Unknown FIELDS within
known arrays are rejected with a per-item error (ADR 012 hostile-input rules).
Auth: shared secret in X-HC-Secret header; the API layer verifies it before calling
process_payload.

MOCK_PAYLOAD below is a faithful replica of what the Withings scale + Health Connect
Webhook app sends, used for development and CI testing until the real scale arrives.
Withings research basis: Health Connect writes one WeightRecord per measurement in kg;
exercise sessions come from Google Fit / the platform step counter.
"""

from typing import Any

from pydantic import BaseModel, Field

from domains.health_connect.types import (
    content_hash_exercise,
    content_hash_weight,
    define_health_connect_types,
)
from kernel import services
from kernel.access import AccessContext

SOURCE = "health_connect"

# Fields the app is allowed to send in each known array.
# Unknown fields are refused; unknown TOP-LEVEL arrays are ignored.
_WEIGHT_FIELDS = {"kilograms", "time"}
_EXERCISE_FIELDS = {
    "type",
    "start_time",
    "end_time",
    "duration_seconds",
    "distance_meters",
    "steps",
    "avg_cadence_spm",
    "max_cadence_spm",
    "stride_length_m",
}

# ---------------------------------------------------------------------------
# Mock payload — mirrors the Health Connect Webhook output for a Withings scale
# reading plus a 45-minute walk on a Pixel phone.
#
# Withings WBS10 (or similar) → Health Connect WeightRecord → HC Webhook app:
#   - one record per weigh-in, kilograms precision ~0.05 kg
#   - source_app_package_name: "com.withings.wiscale2" (not in payload body)
#   - time field is ISO 8601 with timezone offset
#
# Exercise comes from the phone's step counter (WALKING) or paired workout app.
# The HC Webhook app snake_cases the Health Connect field names directly.
# ---------------------------------------------------------------------------
MOCK_PAYLOAD: dict[str, Any] = {
    "timestamp": "2026-08-08T07:00:00+00:00",
    "app_version": "1.0.4",
    "weight": [
        {"kilograms": 83.15, "time": "2026-08-08T06:58:22+00:00"},
    ],
    "exercise": [
        {
            "type": "WALKING",
            "start_time": "2026-08-08T06:05:00+00:00",
            "end_time": "2026-08-08T06:50:00+00:00",
            "duration_seconds": 2700,
            "distance_meters": 3480.0,
            "steps": 4150,
            "avg_cadence_spm": 92.2,
            "stride_length_m": 0.839,
        }
    ],
}


class IngestResult(BaseModel):
    weight_ingested: int = 0
    activity_ingested: int = 0
    errors: list[str] = Field(default_factory=list)


def _validate_weight(item: Any) -> dict[str, Any]:
    if not isinstance(item, dict):
        raise ValueError("weight item must be an object")
    unknown = set(item) - _WEIGHT_FIELDS
    if unknown:
        raise ValueError(f"unknown weight fields: {sorted(unknown)}")
    for req in ("kilograms", "time"):
        if req not in item:
            raise ValueError(f"weight item missing required field: {req!r}")
    return item


def _validate_exercise(item: Any) -> dict[str, Any]:
    if not isinstance(item, dict):
        raise ValueError("exercise item must be an object")
    unknown = set(item) - _EXERCISE_FIELDS
    if unknown:
        raise ValueError(f"unknown exercise fields: {sorted(unknown)}")
    for req in ("type", "start_time", "duration_seconds"):
        if req not in item:
            raise ValueError(f"exercise item missing required field: {req!r}")
    return item


def process_payload(ctx: AccessContext, payload: dict[str, Any]) -> IngestResult:
    """Validate and capture one HC webhook delivery. Idempotent."""
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")
    define_health_connect_types(ctx)
    result = IngestResult()

    for item in payload.get("weight", []):
        try:
            w = _validate_weight(item)
        except ValueError as exc:
            result.errors.append(f"weight: {exc}")
            continue
        ch = content_hash_weight(float(w["kilograms"]), str(w["time"]))
        services.capture(
            ctx,
            "weight_measurement",
            {
                "content_hash": ch,
                "kilograms": float(w["kilograms"]),
                "time": str(w["time"]),
                "source": SOURCE,
            },
            actor=SOURCE,
        )
        result.weight_ingested += 1

    for item in payload.get("exercise", []):
        try:
            ex = _validate_exercise(item)
        except ValueError as exc:
            result.errors.append(f"exercise: {exc}")
            continue
        ch = content_hash_exercise(
            str(ex["type"]), str(ex["start_time"]), int(ex["duration_seconds"])
        )
        attrs: dict[str, Any] = {
            "content_hash": ch,
            "exercise_type": str(ex["type"]),
            "start_time": str(ex["start_time"]),
            "duration_seconds": int(ex["duration_seconds"]),
            "source": SOURCE,
        }
        for opt in ("end_time", "distance_meters", "steps", "avg_cadence_spm",
                    "max_cadence_spm", "stride_length_m"):
            if opt in ex:
                attrs[opt] = ex[opt]
        services.capture(ctx, "activity_summary", attrs, actor=SOURCE)
        result.activity_ingested += 1

    return result
