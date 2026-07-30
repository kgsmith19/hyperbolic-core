"""Ops types as registry data (invariant 1, ADR 014). Zero kernel DDL.

The `ops` domain is the scheduler's own record: what ran (`execution_receipt`),
what a run produced (`briefing`), and whether it was worth producing
(`trigger_feedback`). It is deliberately not `wellbeing` and not `calendar` —
the briefing summarizes both, so living in either would turn one domain's read
scope into a door onto the other's content (ADR 014).
"""

from typing import Any

from kernel.access import AccessContext
from kernel.services import define_missing

DOMAIN = "ops"

MAX_SUMMARY = 512
MAX_NOTE = 500
MAX_IDS = 500

STATUS_OK = "ok"
STATUS_FAILED = "failed"
STATUS_SKIPPED = "skipped"
STATUSES = (STATUS_OK, STATUS_FAILED, STATUS_SKIPPED)

VERDICTS = ("useful", "noise", "wrong")

_TIMESTAMP = {"type": "string", "maxLength": 64}
_UUID = {
    "type": "string",
    "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
}
_UUID_LIST = {"type": "array", "items": _UUID, "maxItems": MAX_IDS}

# One row per scheduled run, emitted on success, failure and skip alike. No
# x-identity: every run is a distinct fact and must never resolve onto an
# earlier one. `summary` is composed from counts and exception class names —
# never an exception message and never feed text, because an entity outlives
# what it quotes and forget() is per-entity (invariant 9, ADR 012/014).
EXECUTION_RECEIPT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "job": {"type": "string", "maxLength": 128},
        "started_at": _TIMESTAMP,
        "finished_at": _TIMESTAMP,
        "status": {"type": "string", "enum": list(STATUSES)},
        "summary": {"type": "string", "maxLength": MAX_SUMMARY},
        "produced_entity_ids": _UUID_LIST,
    },
    "required": ["job", "started_at", "finished_at", "status"],
    "additionalProperties": False,
    # no x-identity: never resolve one run onto another
    # no x-pii: this type carries no person-identifying value, by design
}

_PROVENANCE = {
    "type": "object",
    "properties": {
        "source_entity_ids": _UUID_LIST,
        "source_event_ids": {"type": "array", "items": _UUID, "maxItems": MAX_IDS},
        "method": {"type": "string", "maxLength": 64},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    },
    "required": ["source_entity_ids", "source_event_ids", "method", "confidence"],
    "additionalProperties": False,
}

# The utility gate (ADR 019 rule 9): the briefing reports its own usage bar —
# days-with-a-check-in per week over the GATE_WEEKS complete weeks behind a
# Monday, and whether every week reached GATE_DAYS_PER_WEEK. Counts and a
# boolean only, restart-neutral (rule 2): the narration is the reader's.
GATE_WEEKS = 4
GATE_DAYS_PER_WEEK = 5

_GATE = {
    "type": "object",
    "properties": {
        "weeks": {
            "type": "array",
            "items": {"type": "integer", "minimum": 0, "maximum": 7},
            "minItems": GATE_WEEKS,
            "maxItems": GATE_WEEKS,
        },
        "met": {"type": "boolean"},
    },
    "required": ["weeks", "met"],
    "additionalProperties": False,
}

# The assembled daily briefing: IDs only, never the text they point at. No
# titles, no locations, no attendee emails, no note text — so this type carries
# no x-pii and needs no erasure path of its own, and a briefing that outlives an
# erasure still resolves to correctly redacted entities (ADR 014).
# Recomposed in INT1 (roadmap §INT1, ADR 019 rule 1) into the one morning
# digest, in order: the focus intentions (their entities carry floors and next
# physical actions), then today's appointments, then nothing else until later
# slices' data exists. The open-review and latest-check-in pointers B3 shipped
# left the digest with that recomposition — feelings are pull-only, and the
# digest carries no backlog counts. `gate` appears on the Monday (weekly)
# edition only. An existing database needs
# `scripts/migrate_briefing_composition.py` once before the first recomposed
# run. `briefing_key` is the local date, and is deliberately NOT named `date`:
# ExactIdentityResolver matches on identity field *name* across types and
# daily_checkin already claims `date`, so a briefing keyed on `date` would
# resolve onto that day's check-in and merge into it.
BRIEFING_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "briefing_key": {"type": "string", "maxLength": 32},
        "date": {"type": "string", "maxLength": 32},
        "focus_intention_ids": _UUID_LIST,
        "appointment_ids": _UUID_LIST,
        "gate": _GATE,
        "provenance": _PROVENANCE,
    },
    "required": ["briefing_key", "date", "focus_intention_ids", "appointment_ids", "provenance"],
    "additionalProperties": False,
    "x-identity": ["briefing_key"],
}

# A human's verdict on a scheduled output. Nothing writes this automatically.
# Keyed on subject_id so re-judging supersedes via entity.updated and the
# earlier verdict stays in history (invariant 3). `note` is free text the owner
# writes and may name a person, so it is PII-flagged and erasable.
TRIGGER_FEEDBACK_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "subject_id": _UUID,
        "verdict": {"type": "string", "enum": list(VERDICTS)},
        "note": {"type": "string", "maxLength": MAX_NOTE},
        "recorded_at": _TIMESTAMP,
    },
    "required": ["subject_id", "verdict", "recorded_at"],
    "additionalProperties": False,
    "x-identity": ["subject_id"],
    "x-pii": ["note"],
}

_TYPES = {
    "execution_receipt": EXECUTION_RECEIPT_SCHEMA,
    "briefing": BRIEFING_SCHEMA,
    "trigger_feedback": TRIGGER_FEEDBACK_SCHEMA,
}


def define_ops_types(ctx: AccessContext) -> list[str]:
    """Define any missing ops types. Idempotent; returns what it defined."""
    return define_missing(ctx, DOMAIN, _TYPES)
