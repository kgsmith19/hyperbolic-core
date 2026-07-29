"""Calendar types as registry data (invariant 1, ADR 012). Zero kernel DDL.

Schemas bound every text field (feed content is untrusted) and close
``additionalProperties`` so unvetted feed junk cannot land in attributes.
The attendee identity field is deliberately ``email`` (singular) — distinct
from person's ``emails`` — so ingestion never merges onto the person spine;
linking attendees to people is the B2 auto-link slice, on purpose.
"""

from typing import Any

from kernel.access import AccessContext
from kernel.services import define_type, list_types

DOMAIN = "calendar"

MAX_TEXT = 512  # title/location bound; parse truncates to match

_SHA256 = {"type": "string", "minLength": 64, "maxLength": 64, "pattern": "^[0-9a-f]{64}$"}
_TIMESTAMP = {"type": "string", "maxLength": 64}

APPOINTMENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "ics_key": {"type": "string", "maxLength": 600},
        "uid": {"type": "string", "maxLength": 255},
        "title": {"type": "string", "maxLength": MAX_TEXT},
        "starts_at": _TIMESTAMP,
        "ends_at": _TIMESTAMP,
        "location": {"type": "string", "maxLength": MAX_TEXT},
        "status": {"type": "string", "maxLength": 32},
        "sequence": {"type": "integer", "minimum": 0},
        "all_day": {"type": "boolean"},
        "vevent_hash": _SHA256,
    },
    "required": ["ics_key", "uid", "title", "starts_at", "vevent_hash"],
    "additionalProperties": False,
    "x-identity": ["ics_key"],
    "x-pii": ["title", "location"],
}

ATTENDEE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "email": {"type": "string", "maxLength": 255},
        "name": {"type": "string", "maxLength": 255},
    },
    "required": ["email"],
    "additionalProperties": False,
    "x-identity": ["email"],
    "x-pii": ["email", "name"],
}

# The receipt is hash-plus-metadata, never the payload: verbatim feed text
# carries every attendee's PII and cannot be erased per-subject, since forget()
# is per-entity (invariant 9, ADR 012). sha256 is the tamper evidence — the
# feed can be re-fetched and compared. The URL is never stored either — it can
# embed a private token — only a redacted host and a sha256 of the URL.
SOURCE_RECEIPT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "receipt_key": {"type": "string", "maxLength": 129},
        "sha256": _SHA256,
        "url_hash": _SHA256,
        "source_host": {"type": "string", "maxLength": 255},
        "fetched_at": _TIMESTAMP,
        "size_bytes": {"type": "integer", "minimum": 0},
        "occurrence_count": {"type": "integer", "minimum": 0},
        "skipped_count": {"type": "integer", "minimum": 0},
    },
    "required": [
        "receipt_key",
        "sha256",
        "url_hash",
        "source_host",
        "fetched_at",
        "size_bytes",
    ],
    "additionalProperties": False,
    "x-identity": ["receipt_key"],
}

_TYPES = {
    "appointment": APPOINTMENT_SCHEMA,
    "attendee": ATTENDEE_SCHEMA,
    "source_receipt": SOURCE_RECEIPT_SCHEMA,
}


def define_calendar_types(ctx: AccessContext) -> list[str]:
    """Define any missing calendar types. Idempotent; returns what it defined."""
    existing = {t.name for t in list_types(ctx)}
    defined = []
    for name, schema in _TYPES.items():
        if name not in existing:
            define_type(ctx, name, DOMAIN, schema)
            defined.append(name)
    return defined
