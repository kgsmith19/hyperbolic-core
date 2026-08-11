"""Money types as registry data (invariant 1, roadmap C0/C0.5). Zero kernel DDL.

Five types: one account, one transaction, the receipt of one pull/import
that produced them, and two derived-only types from the C0.5 detector
(``recurring_charge``, ``pay_period``).

- ``account`` — identified by ``account_key``, a sha256 of ``source`` plus an
  external reference (the SimpleFIN account id, or a CSV-supplied label),
  never the raw reference itself: unlike the cpap ``session_date`` precedent,
  the reference here is not identity-safe on its own (it can be a bank
  account nickname), so it is hashed before it ever becomes an identity value
  a resolver matches on. ``name`` is ``x-pii`` and optional so ``forget()``
  can remove it and a later pull still resolves onto the same entity by its
  hash instead of minting a duplicate.
- ``transaction`` — identified by ``transaction_key``, a sha256 of exactly
  the roadmap-specified idempotency tuple: ``(account, posted_date, amount,
  normalized_desc)``. ``account_key``, ``posted_date`` and ``source`` are
  required and not PII (needed to recompute the identity hash and to answer
  per-date/per-account spend queries); ``amount``, ``description``,
  ``normalized_desc``, ``currency``, ``pending`` and ``external_id`` are
  ``x-pii`` and deliberately not required — the cpap ``usage_min`` precedent:
  an erased transaction stays findable by its identity hash, and a re-pull or
  re-import of the same window must never write the erased values back.
- ``money_source_receipt`` — hash-plus-metadata receipt of one SimpleFIN pull
  or one CSV import, mirroring ``cpap_source_receipt`` /
  ``calendar.source_receipt``. Never the verbatim response body or CSV
  bytes, which are the source's own financial-data-shaped payload and cannot
  be erased per-subject.

Identity field names here (``account_key``, ``transaction_key``,
``receipt_key``, ``recurring_charge_key``, ``pay_period_key``) are new and
chosen not to collide with any identity field name another domain already
declares (``ExactIdentityResolver`` matches by field name across every type,
not just within a domain).

- ``recurring_charge`` — one merchant/amount/cadence series detected by
  ``domains.money.recurring`` (roadmap C0.5), identified by
  ``recurring_charge_key`` (sha256 of ``account_key|normalized_desc`` — the
  series identity, independent of any one occurrence). ``status`` is
  ``"confirmed"`` or ``"review"``: the detector never writes ``"confirmed"``
  for a series it could not fully corroborate (an ambiguous/mixed cadence, an
  amount that varies past tolerance, or too few occurrences) — that series is
  written as ``"review"`` with a ``review_reason`` instead, and a
  review-status record carries no ``cadence_days`` because none was
  established. Every record cites the transaction entities it was built from
  in ``provenance`` (ADR 010); ``normalized_desc`` and ``typical_amount`` are
  ``x-pii`` (derived from the transaction fields that are).
- ``pay_period`` — one pay-period window built only from a *confirmed*
  recurring deposit series (never from a review-status one — the C0.5
  acceptance bar: ambiguity must never promote to a pay-period fact),
  identified by ``pay_period_key`` (sha256 of ``account_key|start_date``).
  ``closed`` is false for the most recent, still-open period, whose
  ``end_date`` is a cadence-projected estimate rather than an observed
  deposit. ``typical_amount`` is ``x-pii``.
"""

from typing import Any

from kernel.access import AccessContext
from kernel.services import define_missing

DOMAIN = "money"

SOURCE_SIMPLEFIN = "simplefin"
SOURCE_CSV = "csv"
SOURCES = [SOURCE_SIMPLEFIN, SOURCE_CSV]

_DATE = {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"}
_SHA256_HEX = {
    "type": "string",
    "minLength": 64,
    "maxLength": 64,
    "pattern": "^[0-9a-f]{64}$",
}
_TIMESTAMP = {"type": "string", "maxLength": 64}
_CURRENCY = {"type": "string", "minLength": 3, "maxLength": 3, "pattern": "^[A-Z]{3}$"}

MAX_NAME = 128
MAX_DESCRIPTION = 256
MAX_EXTERNAL_ID = 128
MAX_AMOUNT = 1_000_000_000  # generous outer bound on a malformed reading
MAX_IDS = 200

STATUS_CONFIRMED = "confirmed"
STATUS_REVIEW = "review"
RECURRING_STATUSES = [STATUS_CONFIRMED, STATUS_REVIEW]

# Why a series is not confirmed: too few occurrences to trust a cadence at
# all, a cadence that does not settle on one bucket (or settles on none), or
# an amount that drifts past tolerance. Exactly one is recorded per series --
# whichever the detector checks first (domains.money.recurring.analyze_series).
REASON_INSUFFICIENT_HISTORY = "insufficient_history"
REASON_CADENCE_IRREGULAR = "cadence_irregular"
REASON_AMOUNT_VARIANCE = "amount_variance"
REASON_MULTIPLE_PAYCHECK_SERIES = "multiple_paycheck_series"
REASON_MISSING_PAYCHECKS = "missing_paychecks"
REVIEW_REASONS = [
    REASON_INSUFFICIENT_HISTORY,
    REASON_CADENCE_IRREGULAR,
    REASON_AMOUNT_VARIANCE,
    REASON_MULTIPLE_PAYCHECK_SERIES,
    REASON_MISSING_PAYCHECKS,
]

CADENCE_DAYS = [7, 14, 30, 90, 365]

ACCOUNT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "account_key": _SHA256_HEX,
        "name": {"type": "string", "minLength": 1, "maxLength": MAX_NAME},
        "source": {"type": "string", "enum": SOURCES},
        "currency": _CURRENCY,
    },
    "required": ["account_key", "source"],
    "additionalProperties": False,
    "x-identity": ["account_key"],
    "x-pii": ["name"],
}

TRANSACTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "transaction_key": _SHA256_HEX,
        "account_key": _SHA256_HEX,
        "posted_date": _DATE,
        "source": {"type": "string", "enum": SOURCES},
        "amount": {"type": "number", "minimum": -MAX_AMOUNT, "maximum": MAX_AMOUNT},
        "description": {"type": "string", "minLength": 1, "maxLength": MAX_DESCRIPTION},
        "normalized_desc": {"type": "string", "minLength": 1, "maxLength": MAX_DESCRIPTION},
        "currency": _CURRENCY,
        "pending": {"type": "boolean"},
        "external_id": {"type": "string", "minLength": 1, "maxLength": MAX_EXTERNAL_ID},
    },
    "required": ["transaction_key", "account_key", "posted_date", "source"],
    "additionalProperties": False,
    "x-identity": ["transaction_key"],
    "x-pii": [
        "amount",
        "description",
        "normalized_desc",
        "currency",
        "pending",
        "external_id",
    ],
}

MONEY_SOURCE_RECEIPT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "receipt_key": {"type": "string", "maxLength": 160},
        "sha256": _SHA256_HEX,
        "fetched_at": _TIMESTAMP,
        "window_start": _DATE,
        "window_end": _DATE,
        "transaction_count": {"type": "integer", "minimum": 0},
        "source": {"type": "string", "enum": SOURCES},
    },
    "required": [
        "receipt_key",
        "sha256",
        "fetched_at",
        "window_start",
        "window_end",
        "transaction_count",
        "source",
    ],
    "additionalProperties": False,
    "x-identity": ["receipt_key"],
    # no x-pii: hash-plus-metadata only, never the response/file body
}

_UUID = {
    "type": "string",
    "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
}


def _provenance_schema() -> dict[str, Any]:
    """The ADR 010 envelope. ``confidence`` is never 1.0 for a review-status
    record -- see ``domains.money.recurring``'s module docstring for why."""
    return {
        "type": "object",
        "properties": {
            "source_entity_ids": {"type": "array", "items": _UUID, "maxItems": MAX_IDS},
            "source_event_ids": {"type": "array", "items": _UUID, "maxItems": MAX_IDS},
            "method": {"type": "string", "maxLength": 64},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        },
        "required": ["source_entity_ids", "source_event_ids", "method", "confidence"],
        "additionalProperties": False,
    }


RECURRING_CHARGE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "recurring_charge_key": _SHA256_HEX,
        "account_key": _SHA256_HEX,
        "normalized_desc": {"type": "string", "minLength": 1, "maxLength": MAX_DESCRIPTION},
        "status": {"type": "string", "enum": RECURRING_STATUSES},
        "review_reason": {"type": "string", "enum": REVIEW_REASONS},
        "cadence_days": {"type": "integer", "enum": CADENCE_DAYS},
        "typical_amount": {"type": "number", "minimum": -MAX_AMOUNT, "maximum": MAX_AMOUNT},
        "occurrence_count": {"type": "integer", "minimum": 0},
        "first_seen": _DATE,
        "last_seen": _DATE,
        "provenance": _provenance_schema(),
    },
    "required": [
        "recurring_charge_key",
        "account_key",
        "normalized_desc",
        "status",
        "typical_amount",
        "occurrence_count",
        "first_seen",
        "last_seen",
        "provenance",
    ],
    "additionalProperties": False,
    "x-identity": ["recurring_charge_key"],
    "x-pii": ["normalized_desc", "typical_amount"],
}

PAY_PERIOD_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "pay_period_key": {"type": "string", "maxLength": 160},
        "account_key": _SHA256_HEX,
        "start_date": _DATE,
        "end_date": _DATE,
        "closed": {"type": "boolean"},
        "cadence_days": {"type": "integer", "enum": CADENCE_DAYS},
        "typical_amount": {"type": "number", "minimum": -MAX_AMOUNT, "maximum": MAX_AMOUNT},
        "provenance": _provenance_schema(),
    },
    "required": [
        "pay_period_key",
        "account_key",
        "start_date",
        "end_date",
        "closed",
        "cadence_days",
        "typical_amount",
        "provenance",
    ],
    "additionalProperties": False,
    "x-identity": ["pay_period_key"],
    "x-pii": ["typical_amount"],
}

_TYPES = {
    "account": ACCOUNT_SCHEMA,
    "transaction": TRANSACTION_SCHEMA,
    "money_source_receipt": MONEY_SOURCE_RECEIPT_SCHEMA,
    "recurring_charge": RECURRING_CHARGE_SCHEMA,
    "pay_period": PAY_PERIOD_SCHEMA,
}


def define_money_types(ctx: AccessContext) -> list[str]:
    """Define any missing money types. Idempotent; returns what it defined."""
    return define_missing(ctx, DOMAIN, _TYPES)
