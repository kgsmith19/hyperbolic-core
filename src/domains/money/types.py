"""Money types as registry data (invariant 1, roadmap C0). Zero kernel DDL.

Three types: one account, one transaction, and the receipt of one pull/
import that produced them.

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
``receipt_key``) are new and chosen not to collide with any identity field
name another domain already declares (``ExactIdentityResolver`` matches by
field name across every type, not just within a domain).
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

_TYPES = {
    "account": ACCOUNT_SCHEMA,
    "transaction": TRANSACTION_SCHEMA,
    "money_source_receipt": MONEY_SOURCE_RECEIPT_SCHEMA,
}


def define_money_types(ctx: AccessContext) -> list[str]:
    """Define any missing money types. Idempotent; returns what it defined."""
    return define_missing(ctx, DOMAIN, _TYPES)
