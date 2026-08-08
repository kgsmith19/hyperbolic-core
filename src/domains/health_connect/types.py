"""Health Connect types (invariant 1). Zero kernel DDL.

weight_measurement: one scale reading in kg, identity-keyed by sha256(metric+time+kg).
activity_summary: one exercise session, identity-keyed by sha256(type+start+duration).

Content-hash identity keys are non-PII, so erasure is durable: forget() strips
user-supplied fields but the hash survives, keeping the entity findable. The app
sends a rolling 48-hour window and retries — duplicate delivery must merge silently.

Withings scales write to Health Connect in kilograms; that is what we store.
Convert to other units at read time, never at the edge.
"""

from hashlib import sha256
from typing import Any

from kernel.access import AccessContext
from kernel.services import define_missing

DOMAIN = "health_connect"

_TIMESTAMP = {"type": "string", "maxLength": 64}
_SHA256_HEX = {
    "type": "string",
    "minLength": 64,
    "maxLength": 64,
    "pattern": "^[0-9a-f]{64}$",
}

WEIGHT_MEASUREMENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "content_hash": _SHA256_HEX,   # sha256("weight:{time}:{kg}"); non-PII identity
        "kilograms": {"type": "number", "minimum": 0, "maximum": 500},
        "time": _TIMESTAMP,
        "source": {"type": "string", "maxLength": 64},
    },
    "required": ["content_hash", "kilograms", "time"],
    "additionalProperties": False,
    "x-identity": ["content_hash"],
}

ACTIVITY_SUMMARY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "content_hash": _SHA256_HEX,   # sha256("exercise:{type}:{start}:{duration_s}")
        "exercise_type": {"type": "string", "maxLength": 64},
        "start_time": _TIMESTAMP,
        "end_time": _TIMESTAMP,
        "duration_seconds": {"type": "integer", "minimum": 0},
        "distance_meters": {"type": "number", "minimum": 0},
        "steps": {"type": "integer", "minimum": 0},
        "avg_cadence_spm": {"type": "number", "minimum": 0},
        "max_cadence_spm": {"type": "number", "minimum": 0},
        "stride_length_m": {"type": "number", "minimum": 0},
        "source": {"type": "string", "maxLength": 64},
    },
    "required": ["content_hash", "exercise_type", "start_time", "duration_seconds"],
    "additionalProperties": False,
    "x-identity": ["content_hash"],
}

_TYPES = {
    "weight_measurement": WEIGHT_MEASUREMENT_SCHEMA,
    "activity_summary": ACTIVITY_SUMMARY_SCHEMA,
}


def content_hash_weight(kilograms: float, time: str) -> str:
    return sha256(f"weight:{time}:{kilograms}".encode()).hexdigest()


def content_hash_exercise(exercise_type: str, start_time: str, duration_seconds: int) -> str:
    return sha256(f"exercise:{exercise_type}:{start_time}:{duration_seconds}".encode()).hexdigest()


def define_health_connect_types(ctx: AccessContext) -> list[str]:
    """Define any missing health_connect types. Idempotent; returns what it defined."""
    return define_missing(ctx, DOMAIN, _TYPES)
