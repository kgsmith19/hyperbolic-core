"""CPAP types as registry data (invariant 1, roadmap H2). Zero kernel DDL.

cpap_session: one night's therapy data from SleepHQ. usage_min and the four
clinical fields (ahi, leak_95p, pressure_95p, central_ahi) are x-pii — they
describe the severity of a diagnosed condition and therapy adherence, which
is health data about a person (invariant 9). session_date is the identity key
and is never PII (the identity-is-never-PII rule, ADR 012 "Durable erasure"):
an erased night stays findable by date, so the next ingest run updates it
instead of minting a duplicate entity carrying the values that were erased.

cpap_source_receipt: hash-plus-metadata receipt of one SleepHQ API pull,
mirroring domains.calendar.types.SOURCE_RECEIPT_SCHEMA. Never the verbatim
API response body, which is the source's own PHI-shaped payload and cannot be
erased per-subject.

Identity field names here (session_date, cpap_receipt_key) are chosen not to
collide with any identity field name another domain already declares:
ExactIdentityResolver matches on field *name* across every type, not just
within a domain (the cell constitution explains why this matters).
"""

from typing import Any

from kernel.access import AccessContext
from kernel.services import define_missing

DOMAIN = "cpap"

_DATE = {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"}
_SHA256_HEX = {
    "type": "string",
    "minLength": 64,
    "maxLength": 64,
    "pattern": "^[0-9a-f]{64}$",
}
_TIMESTAMP = {"type": "string", "maxLength": 64}

MAX_USAGE_MIN = 24 * 60  # a night cannot exceed 24 hours of usage
MAX_AHI = 300  # events/hour; generous upper bound on a malformed reading
MAX_LEAK = 1000  # L/min; generous upper bound on a malformed reading
MAX_PRESSURE = 40  # cmH2O; generous upper bound on a malformed reading

CPAP_SESSION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "session_date": _DATE,
        "usage_min": {"type": "integer", "minimum": 0, "maximum": MAX_USAGE_MIN},
        "ahi": {"type": "number", "minimum": 0, "maximum": MAX_AHI},
        "leak_95p": {"type": "number", "minimum": 0, "maximum": MAX_LEAK},
        "pressure_95p": {"type": "number", "minimum": 0, "maximum": MAX_PRESSURE},
        "central_ahi": {"type": "number", "minimum": 0, "maximum": MAX_AHI},
        "source": {"type": "string", "enum": ["sleephq"]},
    },
    # usage_min is x-pii, so it cannot be required (the calendar `title`
    # precedent): forget() removes it, and an erased night must still be
    # capturable on the next ingest pull.
    "required": ["session_date", "source"],
    "additionalProperties": False,
    "x-identity": ["session_date"],
    "x-pii": ["usage_min", "ahi", "leak_95p", "pressure_95p", "central_ahi"],
}

CPAP_SOURCE_RECEIPT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "cpap_receipt_key": {"type": "string", "maxLength": 160},
        "sha256": _SHA256_HEX,
        "fetched_at": _TIMESTAMP,
        "window_start": _DATE,
        "window_end": _DATE,
        "session_count": {"type": "integer", "minimum": 0},
        "source": {"type": "string", "enum": ["sleephq"]},
    },
    "required": [
        "cpap_receipt_key",
        "sha256",
        "fetched_at",
        "window_start",
        "window_end",
        "session_count",
        "source",
    ],
    "additionalProperties": False,
    "x-identity": ["cpap_receipt_key"],
    # no x-pii: hash-plus-metadata only, never the response body
}

MAX_LAB_NAME = 128
MAX_CADENCE_DAYS = 3650  # 10 years, a generous outer bound

LAB_LOG_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "lab_key": _SHA256_HEX,  # sha256("{lab_name}|{date}"), lowercased
        "lab_name": {"type": "string", "minLength": 1, "maxLength": MAX_LAB_NAME},
        "date": _DATE,
        "cadence_days": {"type": "integer", "minimum": 1, "maximum": MAX_CADENCE_DAYS},
    },
    "required": ["lab_key", "lab_name", "date"],
    "additionalProperties": False,
    "x-identity": ["lab_key"],
    "x-pii": ["lab_name", "date", "cadence_days"],
}

_TYPES = {
    "cpap_session": CPAP_SESSION_SCHEMA,
    "cpap_source_receipt": CPAP_SOURCE_RECEIPT_SCHEMA,
    "lab_log": LAB_LOG_SCHEMA,
}


def define_cpap_types(ctx: AccessContext) -> list[str]:
    """Define any missing cpap types. Idempotent; returns what it defined."""
    return define_missing(ctx, DOMAIN, _TYPES)
