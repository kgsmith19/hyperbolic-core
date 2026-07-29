"""Calendar types as registry data (invariant 1, ADR 012). Zero kernel DDL.

Schemas bound every text field (feed content is untrusted) and close
``additionalProperties`` so unvetted feed junk cannot land in attributes.
The attendee identity field is ``email_hash`` (see below) and never the
person spine's ``emails``, so ingestion never merges onto the spine; attendees
are linked to people by the auto-link pass instead, which emits an edge and
never rewrites the spine (``autolink.py``, ADR 013).

PII fields are never identity fields here: an identity field must survive
``forget()`` or erasure undoes itself on the next feed edit (invariant 9,
ADR 012 "Durable erasure").
"""

from hashlib import sha256
from typing import Any

from kernel.access import AccessContext
from kernel.services import define_missing

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
    # `title` is x-pii, so it cannot be required: forget() removes it from live
    # state, and an erased appointment must still be capturable on the next
    # feed edit (that is how its non-PII fields keep updating).
    "required": ["ics_key", "uid", "starts_at", "vevent_hash"],
    "additionalProperties": False,
    "x-identity": ["ics_key"],
    "x-pii": ["title", "location"],
}


def email_hash(email: str) -> str:
    """The attendee identity key: sha256 of the normalized address, hex.

    Hashing an email is NOT anonymization — an address is a known, small,
    guessable domain, so anyone holding a candidate address can confirm a
    match. It is a stable join key, acceptable here only because it never
    leaves the system and the app cannot render it back to an address.

    What it buys is durable erasure. The identity field is the one attribute
    ingestion must be able to look an entity up by, and PII is exactly what
    forget() removes; keying on the address itself meant a redacted attendee
    became unfindable and the next feed change minted a brand-new entity
    carrying the same address (invariant 9, ADR 012 "Durable erasure").
    """
    return sha256(email.strip().lower().encode()).hexdigest()


ATTENDEE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "email_hash": _SHA256,
        "email": {"type": "string", "maxLength": 255},
        "name": {"type": "string", "maxLength": 255},
    },
    # Only the non-PII identity key is required; an erased attendee has no
    # `email` left and must still resolve to its existing entity.
    "required": ["email_hash"],
    "additionalProperties": False,
    "x-identity": ["email_hash"],
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

_UUID = {
    "type": "string",
    "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
}

# The dedup-review queue (ADR 013): what the auto-link pass refused to guess at.
# It holds entity IDs and a reason code and NOTHING else — deliberately no
# email, no display name, no free text. `entity.search` is a generated tsvector
# over `attributes::text` and forget() is strictly per-entity, so an email
# copied here would survive erasure of the attendee it belongs to and stay
# full-text searchable (reachable through chat, which reads every domain).
# The attendee's own record stays the single place its email lives; a reviewer
# resolves the item by reading the referenced entities.
LINK_REVIEW_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "review_key": {"type": "string", "maxLength": 128},
        "attendee_id": _UUID,
        "candidate_person_ids": {"type": "array", "items": _UUID, "maxItems": 50},
        "reason": {
            "type": "string",
            "enum": ["ambiguous_email_match", "conflicting_existing_link"],
        },
        "method": {"type": "string", "maxLength": 64},
        "detected_at": _TIMESTAMP,
    },
    "required": ["review_key", "attendee_id", "candidate_person_ids", "reason"],
    "additionalProperties": False,
    "x-identity": ["review_key"],
    # no x-pii: this type carries no person-identifying value, by design
}

_TYPES = {
    "appointment": APPOINTMENT_SCHEMA,
    "attendee": ATTENDEE_SCHEMA,
    "source_receipt": SOURCE_RECEIPT_SCHEMA,
    "link_review": LINK_REVIEW_SCHEMA,
}


def define_calendar_types(ctx: AccessContext) -> list[str]:
    """Define any missing calendar types. Idempotent; returns what it defined."""
    return define_missing(ctx, DOMAIN, _TYPES)
