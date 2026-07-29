"""Bill types as registry data (invariant 1, ADR 016/017). Zero kernel DDL.

Four types, one generic and one medical instance beside it:

- ``bill`` is the GENERIC obligation — issuer, account reference, service and
  due dates, line items, total, currency — discriminated by ``category``. A
  utility bill is ``category: "utility"``; it needs no new type, which is the
  whole point of keeping the core generic.
- ``eob`` is the medical instance: an explanation of benefits, whose line items
  carry the payer split (billed / allowed / plan paid / patient responsibility)
  that no other obligation has.
- ``bill_extraction`` is the per-document record that a run happened: which
  document's text went to which model, when, and what came back. It carries no
  personal value at all and exists so the PHI-to-Anthropic data flow (ADR 016)
  is auditable and so a sweep never sends the same document twice.
- ``verification_receipt`` is the deterministic verifier's ruling over one
  document's candidates (ADR 017): which entity ids were checked, which check
  gave which verdict, and by how much an arithmetic check missed. No model is
  involved in producing it, so unlike a candidate it may honestly carry
  ``confidence: 1.0``.

``status`` gained its second member here. C2 shipped a one-value enum so that
"verified" was inexpressible; C3 is what earns ``"verified"``, and only through
the verifier: the schema refuses the value unless the record also cites the
``verification_receipt_id`` that ruled on it, and ``verify.guard_capture``
turns away a direct ``POST /capture`` that tries to set it (ADR 017).

Everything ``bill`` and ``eob`` hold is PHI/PII, so nearly every field is
``x-pii`` and erasable. What deliberately survives ``forget()`` is the identity
key, the ``candidate`` status, the provenance envelope and the timestamps — an
honest husk that says "a candidate derived from document X once existed" rather
than a record that quietly reconstitutes itself.

Identity is never PII (ADR 012 "Durable erasure"). ``claim_no`` reads as the
natural key for an EOB and is exactly the wrong choice: ``forget()`` strips it,
so an erased EOB would stop being findable and the next extraction of the same
document would mint a brand-new entity carrying the claim number again. The
keys are sha256 digests instead (``extract.record_key``), derived from the
source document's hash plus the identifying values.

**No unbounded free-text field exists here, on purpose.** A line item carries a
bounded code and amounts and no description; ``issuer``/``payer`` are capped at
64 characters over a restricted character class and ``account_ref``/``claim_no``
at 48 with no whitespace at all, and a value that violates either is DROPPED
rather than truncated (``extract._bounded``) — half of an injected instruction
is still injected text in an attribute. ``entity.search`` is a generated
tsvector over ``attributes::text``, so "MRI LUMBAR SPINE W/O CONTRAST" copied
into an attribute would be full-text searchable by anything holding read scope.

Stated honestly: bounding is a mitigation, not a guarantee. A document carrying
injected instructions can still get a short string into ``issuer``. What makes
that survivable is the layering — those fields are ``x-pii`` and therefore
erasable, and the whole domain is ``x-sensitive`` and therefore never readable
by a model. The document itself stays in the blob store for a human (ADR 015).
"""

from typing import Any

from kernel.access import AccessContext
from kernel.services import define_missing

DOMAIN = "bills"

# What a record claims about itself. C2 shipped `candidate` alone so nothing
# could quietly become a fact; C3's deterministic verifier is what earns
# `verified`, and the schema below binds the value to the receipt that granted
# it (ADR 017), so a promotion is never a one-field edit.
STATUS_CANDIDATE = "candidate"
STATUS_VERIFIED = "verified"
STATUSES = (STATUS_CANDIDATE, STATUS_VERIFIED)

CATEGORY_MEDICAL = "medical"
CATEGORIES = (CATEGORY_MEDICAL, "utility", "other")

EXTRACTION_OK = "ok"
EXTRACTION_EMPTY = "empty"
EXTRACTION_REFUSED = "refused"
EXTRACTION_UNPARSABLE = "unparsable"
# The call was transmitted and then failed. The PHI left the box, so this
# outcome needs a record every bit as much as a successful one does.
EXTRACTION_FAILED = "failed"
EXTRACTION_STATUSES = (
    EXTRACTION_OK,
    EXTRACTION_EMPTY,
    EXTRACTION_REFUSED,
    EXTRACTION_UNPARSABLE,
    EXTRACTION_FAILED,
)

# The deterministic checks (ADR 017). Each is reported independently, so a
# receipt says which one failed rather than "verification failed".
CHECK_LINE_ITEMS_SUM = "line_items_sum"
CHECK_EOB_LINE_SPLIT = "eob_line_split"
CHECK_EOB_ALLOWED_WITHIN_BILLED = "eob_allowed_within_billed"
CHECK_EOB_AMOUNTS_NON_NEGATIVE = "eob_amounts_non_negative"
CHECK_DATES_COHERENT = "dates_coherent"
CHECK_NO_DUPLICATE_LINES = "no_duplicate_lines"
CHECK_CURRENCY_CONSISTENT = "currency_consistent"
CHECK_NO_LOW_CONFIDENCE_FIELDS = "no_low_confidence_fields"
CHECK_BILL_EOB_PATIENT_RESP = "bill_eob_patient_resp"
CHECKS = (
    CHECK_LINE_ITEMS_SUM,
    CHECK_EOB_LINE_SPLIT,
    CHECK_EOB_ALLOWED_WITHIN_BILLED,
    CHECK_EOB_AMOUNTS_NON_NEGATIVE,
    CHECK_DATES_COHERENT,
    CHECK_NO_DUPLICATE_LINES,
    CHECK_CURRENCY_CONSISTENT,
    CHECK_NO_LOW_CONFIDENCE_FIELDS,
    CHECK_BILL_EOB_PATIENT_RESP,
)

# `unchecked` is not a pass. An input the extractor never captured means the
# arithmetic could not be done, and "we could not check it" must never read as
# "it is true" — so it blocks promotion exactly as a failure does.
RESULT_PASS = "pass"
RESULT_FAIL = "fail"
RESULT_UNCHECKED = "unchecked"
RESULTS = (RESULT_PASS, RESULT_FAIL, RESULT_UNCHECKED)

MAX_CHECKS = 500

# Bounds tight enough that these cannot hold a sentence, and enforced by a
# character class as well as a length: an "issuer" is a company name, not prose.
MAX_NAME = 64
MAX_REF = 48
MAX_CODE = 16
ORG_PATTERN = "^[A-Za-z0-9][A-Za-z0-9 .,&'()/-]{0,63}$"
REF_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._/-]{0,47}$"
MAX_LINE_ITEMS = 100
MAX_IDS = 100
MAX_FLAGGED_FIELDS = 12

_SHA256 = {"type": "string", "minLength": 64, "maxLength": 64, "pattern": "^[0-9a-f]{64}$"}
_TIMESTAMP = {"type": "string", "maxLength": 64}
_DATE = {"type": "string", "maxLength": 32}
_MONEY = {"type": "number"}
_CURRENCY = {"type": "string", "maxLength": 3, "pattern": "^[A-Z]{3}$"}
_UUID = {
    "type": "string",
    "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
}


def _provenance_schema(ceiling: dict[str, Any]) -> dict[str, Any]:
    """The ADR 010 envelope, with the confidence ceiling spelled out."""
    return {
        "type": "object",
        "properties": {
            "source_entity_ids": {"type": "array", "items": _UUID, "maxItems": MAX_IDS},
            "source_event_ids": {"type": "array", "items": _UUID, "maxItems": MAX_IDS},
            "method": {"type": "string", "maxLength": 64},
            "confidence": {"type": "number", "minimum": 0, **ceiling},
        },
        "required": ["source_entity_ids", "source_event_ids", "method", "confidence"],
        "additionalProperties": False,
    }


# For candidates: confidence 1.0 is refused by the schema itself. 1.0 means a
# direct kernel read (ADR 010), and nothing a model wrote is that — so the type
# system, not just extract.py's cap, keeps an LLM guess from ever looking like
# a fact that C3 already verified.
_PROVENANCE_DERIVED = _provenance_schema({"exclusiveMaximum": 1})
# For the run record: it reports what this process actually did, so 1.0 is honest.
_PROVENANCE_DIRECT = _provenance_schema({"maximum": 1})

# Which fields the model was unsure of, by name. Bounded to lowercase field
# names so this cannot become a free-text channel carrying bill content.
_FLAGGED_FIELDS = {
    "type": "array",
    "maxItems": MAX_FLAGGED_FIELDS,
    "items": {"type": "string", "maxLength": 32, "pattern": "^[a-z_]{1,32}$"},
}

# A bounded billing code (CPT/HCPCS/revenue/tariff) and amounts. There is no
# description field: see the module docstring. The charset excludes whitespace
# and the length is 16, so a code cannot carry a sentence — not a proof that no
# prose fits, but it is bounded, and it is x-pii and therefore erasable.
_CODE = {"type": "string", "maxLength": MAX_CODE, "pattern": "^[A-Za-z0-9][A-Za-z0-9.\\-]{0,15}$"}
# An organization name and a reference number: bounded in length AND charset, in
# the type as well as in the coercion, so a direct `POST /capture` is held to
# the same bar as the extractor.
_ORG = {"type": "string", "maxLength": MAX_NAME, "pattern": ORG_PATTERN}
_REF = {"type": "string", "maxLength": MAX_REF, "pattern": REF_PATTERN}

# A promotion always cites the receipt that granted it, so `"verified"` is never
# a one-word edit and every verified record resolves to the checks behind it.
# This is the type-system half of the promotion guard; `verify.guard_capture` is
# the other half, and neither is the whole answer on its own (ADR 017).
_PROMOTION_CITES_ITS_RECEIPT: dict[str, Any] = {
    "if": {"properties": {"status": {"const": STATUS_VERIFIED}}, "required": ["status"]},
    "then": {"required": ["verification_receipt_id"]},
}

BILL_LINE_ITEM = {
    "type": "object",
    "properties": {"code": _CODE, "quantity": {"type": "number"}, "amount": _MONEY},
    "additionalProperties": False,
}

EOB_LINE_ITEM = {
    "type": "object",
    "properties": {
        "code": _CODE,
        "quantity": {"type": "number"},
        "billed": _MONEY,
        "allowed": _MONEY,
        "plan_paid": _MONEY,
        "patient_resp": _MONEY,
    },
    "additionalProperties": False,
}

BILL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "bill_key": _SHA256,
        "status": {"type": "string", "enum": list(STATUSES)},
        # The receipt that last ruled on this record, promoted or not. Written
        # on every verification run, so a demoted record never keeps a stale
        # pointer: `capture` merges and cannot remove a key (ADR 017).
        "verification_receipt_id": _UUID,
        "category": {"type": "string", "enum": list(CATEGORIES)},
        "issuer": _ORG,
        "account_ref": _REF,
        "service_date": _DATE,
        "due_date": _DATE,
        "currency": _CURRENCY,
        "total": _MONEY,
        "line_items": {
            "type": "array",
            "items": BILL_LINE_ITEM,
            "maxItems": MAX_LINE_ITEMS,
        },
        "low_confidence_fields": _FLAGGED_FIELDS,
        "provenance": _PROVENANCE_DERIVED,
        "extracted_at": _TIMESTAMP,
    },
    # Only the non-PII spine is required: forget() removes every x-pii field
    # from live state, and an erased candidate must still be a valid candidate.
    "required": ["bill_key", "status", "category", "provenance", "extracted_at"],
    "additionalProperties": False,
    "allOf": [_PROMOTION_CITES_ITS_RECEIPT],
    "x-identity": ["bill_key"],
    "x-pii": ["issuer", "account_ref", "service_date", "due_date", "total", "line_items"],
    # Withheld from the shared agent-tool surface, and with it every other type
    # in this domain (ADR 016; scopes are domain-shaped, invariant 5).
    "x-sensitive": True,
}

EOB_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "eob_key": _SHA256,
        "status": {"type": "string", "enum": list(STATUSES)},
        "verification_receipt_id": _UUID,
        # Kept as an attribute and flagged, never as the identity field.
        "claim_no": _REF,
        "payer": _ORG,
        "service_date": _DATE,
        "currency": _CURRENCY,
        "line_items": {
            "type": "array",
            "items": EOB_LINE_ITEM,
            "maxItems": MAX_LINE_ITEMS,
        },
        "low_confidence_fields": _FLAGGED_FIELDS,
        "provenance": _PROVENANCE_DERIVED,
        "extracted_at": _TIMESTAMP,
    },
    "required": ["eob_key", "status", "provenance", "extracted_at"],
    "additionalProperties": False,
    "allOf": [_PROMOTION_CITES_ITS_RECEIPT],
    "x-identity": ["eob_key"],
    "x-pii": ["claim_no", "payer", "service_date", "line_items"],
    "x-sensitive": True,
}

# The audit record of one extraction run over one document: what left the box,
# to which model, when, and what came back. Counts and enums only — no bill
# content, no PII, nothing erasable, so it stays readable after the candidates
# it produced are erased and the fact of the data flow survives.
BILL_EXTRACTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "extraction_key": _UUID,
        "document_id": _UUID,
        "document_sha256": _SHA256,
        "model": {"type": "string", "maxLength": 64},
        "status": {"type": "string", "enum": list(EXTRACTION_STATUSES)},
        "bill_count": {"type": "integer", "minimum": 0},
        "eob_count": {"type": "integer", "minimum": 0},
        "text_chars": {"type": "integer", "minimum": 0},
        "extracted_at": _TIMESTAMP,
        "provenance": _PROVENANCE_DIRECT,
    },
    "required": [
        "extraction_key",
        "document_id",
        "model",
        "status",
        "extracted_at",
        "provenance",
    ],
    "additionalProperties": False,
    "x-identity": ["extraction_key"],
    # no x-pii: this type carries no person-identifying value, by design
}

# One check's verdict. Ids, enums and integers — plus `delta`, the signed
# amount by which an arithmetic check missed. There is no room here for a value
# copied out of the document: no issuer, no payer, no claim number, no line
# amount. `fields` names this record type's own fields and is bounded to that
# shape, so it cannot become a free-text channel any more than
# `low_confidence_fields` can.
_CHECK = {
    "type": "object",
    "properties": {
        "check": {"type": "string", "enum": list(CHECKS)},
        "subject_id": _UUID,
        "result": {"type": "string", "enum": list(RESULTS)},
        "line_index": {"type": "integer", "minimum": 0, "maximum": MAX_LINE_ITEMS},
        "delta": _MONEY,
        "fields": _FLAGGED_FIELDS,
    },
    "required": ["check", "subject_id", "result"],
    "additionalProperties": False,
}

# What the deterministic verifier ruled over one document's candidates
# (ADR 017). Keyed on the document, so re-verifying supersedes rather than
# piling up, and the earlier ruling stays in history (invariant 3).
#
# `confidence: 1.0` is legitimate here and refused on `bill`/`eob`: this record
# reports arithmetic this process performed over kernel state it read directly,
# with no model anywhere in the path (ADR 010's reservation of 1.0 is about
# derivation, not about who wrote the row).
#
# `checks` is `x-pii` because a `delta` is arithmetic over amounts that are
# themselves `x-pii` on the candidate. Coarse in the safe direction: erasing a
# receipt drops every verdict detail and leaves the honest husk — this document
# was verified at this time and did or did not pass. `checks` is therefore not
# `required`, exactly as an erased candidate must remain a valid candidate.
VERIFICATION_RECEIPT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "verification_key": _UUID,
        "document_id": _UUID,
        "subject_ids": {"type": "array", "items": _UUID, "maxItems": MAX_IDS},
        "verified_ids": {"type": "array", "items": _UUID, "maxItems": MAX_IDS},
        "passed": {"type": "boolean"},
        "checks_truncated": {"type": "boolean"},
        "checks": {"type": "array", "items": _CHECK, "maxItems": MAX_CHECKS},
        "checked_at": _TIMESTAMP,
        "provenance": _PROVENANCE_DIRECT,
    },
    "required": ["verification_key", "document_id", "passed", "checked_at", "provenance"],
    "additionalProperties": False,
    "x-identity": ["verification_key"],
    "x-pii": ["checks"],
    # No `x-sensitive` here, deliberately, and it changes nothing: withholding
    # is enforced per DOMAIN because scopes are domain-shaped (invariant 5), and
    # `bill`/`eob` already carry the flag, so the whole `bills` domain — this
    # type included — is withheld from the shared agent-tool surface. That is
    # the same reasoning `bill_extraction` was left unflagged under (ADR 016).
}

BILL_PII_FIELDS: tuple[str, ...] = tuple(BILL_SCHEMA["x-pii"])
EOB_PII_FIELDS: tuple[str, ...] = tuple(EOB_SCHEMA["x-pii"])

TYPE_BILL = "bill"
TYPE_EOB = "eob"
TYPE_EXTRACTION = "bill_extraction"
TYPE_VERIFICATION = "verification_receipt"

# The identity field each candidate type is keyed on, so the verifier can write
# back to the record it just judged without caring which of the two it holds.
KEY_FIELDS = {TYPE_BILL: "bill_key", TYPE_EOB: "eob_key"}

_TYPES = {
    TYPE_BILL: BILL_SCHEMA,
    TYPE_EOB: EOB_SCHEMA,
    TYPE_EXTRACTION: BILL_EXTRACTION_SCHEMA,
    TYPE_VERIFICATION: VERIFICATION_RECEIPT_SCHEMA,
}


def define_bills_types(ctx: AccessContext) -> list[str]:
    """Define any missing bills types. Idempotent; returns what it defined."""
    return define_missing(ctx, DOMAIN, _TYPES)
