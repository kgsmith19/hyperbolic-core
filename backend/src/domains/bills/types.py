"""Bill types as registry data (invariant 1, ADR 016/017/018). Zero kernel DDL.

Six types: one generic obligation, one medical instance beside it, and the
records of what each job did to them.

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
- ``action_proposal`` is a DRAFT outward-facing action that a failed
  verification suggests (ADR 018) — proposed, never taken. It holds the ids and
  the failing check names it rests on and **no draft text at all**: the letter
  is rendered on demand from the records it cites, so no prose about a medical
  bill is ever stored in a full-text-indexed attribute.
- ``authority_receipt`` is what an explicit human approval mints (ADR 018): who
  approved, when, which proposal, the digest of the exact draft they read, and
  the constraints of the grant. Its ``permits`` and ``channel`` are one-member
  enums, so "send this somewhere" is **not expressible** — the same trick C2
  used to make ``"verified"`` inexpressible until something could earn it.

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

# --- proposals and authority (ADR 018) --------------------------------------

# What an action_proposal proposes. One member today; a second one is a new
# ADR, because every kind is a new thing this system might do in the world.
KIND_DISPUTE_DRAFT = "dispute_draft"
PROPOSAL_KINDS = (KIND_DISPUTE_DRAFT,)

# A proposal's lifecycle. `proposed` authorizes nothing; `approved` is the only
# state that has an authority receipt behind it, and the schema below binds the
# two together exactly as `verified` is bound to its verification receipt.
STATE_PROPOSED = "proposed"
STATE_APPROVED = "approved"
STATE_REJECTED = "rejected"
STATE_WITHDRAWN = "withdrawn"
PROPOSAL_STATES = (STATE_PROPOSED, STATE_APPROVED, STATE_REJECTED, STATE_WITHDRAWN)

# What an approval may authorize, and where the result may go. BOTH are
# one-member enums on purpose (invariant 8, ADR 018): there is no outbound
# channel anywhere in this system, and an authority artifact that could say
# "email this" would be a lie the type system is happy to tell. Adding a member
# is a schema change, a migration and a design review — which is exactly the
# friction that should stand between a draft and a sent letter.
ACT_DISPLAY_DRAFT = "display_draft"
GRANTED_ACTS = (ACT_DISPLAY_DRAFT,)
CHANNEL_ON_SCREEN = "on_screen"
CHANNELS = (CHANNEL_ON_SCREEN,)

# How the approving principal was established. Recorded rather than inferred,
# because an authority receipt is the system's only artifact distinguishing a
# human decision from an automated one, and "the environment said so" is a
# weaker claim than "a verified session said so". A third member — an agent
# token holding an approve grant — is a decision nobody has made.
GRANT_VIA_OWNER_SESSION = "owner_session"
GRANT_VIA_LOCAL_DEV = "local_dev"
GRANT_VIAS = (GRANT_VIA_OWNER_SESSION, GRANT_VIA_LOCAL_DEV)

# The checks a proposal may quote back at a third party. A failed check is only
# disputable when it means the DOCUMENT disagrees with itself; a check that
# failed because this system could not read the document is our problem, not
# the provider's, and presenting it as an accusation would be dishonest. The
# rest are counted on the proposal and named in the draft as "not stated here"
# (the C3 "a check that cannot run says so" precedent, pointed outward).
DISPUTABLE_CHECKS = (
    CHECK_LINE_ITEMS_SUM,
    CHECK_EOB_LINE_SPLIT,
    CHECK_EOB_ALLOWED_WITHIN_BILLED,
    CHECK_EOB_AMOUNTS_NON_NEGATIVE,
    CHECK_NO_DUPLICATE_LINES,
    CHECK_BILL_EOB_PATIENT_RESP,
)

MAX_POINTS = 50
# Bounded identifier for the approving principal: the owner's Supabase user id
# in a deployed run, or an explicit local-dev sentinel. Not free text.
MAX_PRINCIPAL = 128
PRINCIPAL_PATTERN = "^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$"

# Bounds tight enough that these cannot hold a sentence, and enforced by a
# character class as well as a length: an "issuer" is a company name, not prose.
MAX_NAME = 64
MAX_REF = 48
MAX_CODE = 16
ORG_PATTERN = "^[A-Za-z0-9][A-Za-z0-9 .,&'()/-]{0,63}$"
REF_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._/-]{0,47}$"
DATE_PATTERN = "^[0-9][0-9W-]{0,31}$"
MAX_LINE_ITEMS = 100
MAX_IDS = 100
MAX_FLAGGED_FIELDS = 12
# The one shape a flagged field name may take, shared by the schema below and
# the coercions in extract.py / verify.py so the three can never drift apart.
FIELD_NAME_PATTERN = "^[a-z_]{1,32}$"

_SHA256 = {"type": "string", "minLength": 64, "maxLength": 64, "pattern": "^[0-9a-f]{64}$"}
_TIMESTAMP = {"type": "string", "maxLength": 64}
# Bounded in charset as well as length, exactly as `_ORG`/`_REF` are: this cell's
# rule is that a string is held to both in the type *and* in the coercion, and a
# date is now composed verbatim into a letter addressed to a third party
# (ADR 018). `date.fromisoformat` — the only writer — emits nothing outside
# digits, `-` and `W`, so this excludes prose without narrowing what is already
# storable; `extract._date` re-checks the same pattern.
_DATE = {"type": "string", "maxLength": 32, "pattern": DATE_PATTERN}
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
    "items": {"type": "string", "maxLength": 32, "pattern": FIELD_NAME_PATTERN},
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

# One thing a draft would say, in the receipt's own vocabulary: which check
# failed, about which record, on which line. No `delta` and no `fields` —
# unlike `verification_receipt.checks` this array carries no arithmetic at all,
# so it holds nothing erasable and the proposal needs no erasure path of its
# own. The numbers a draft quotes are read from the candidates at render time.
_POINT = {
    "type": "object",
    "properties": {
        "check": {"type": "string", "enum": list(DISPUTABLE_CHECKS)},
        "subject_id": _UUID,
        "line_index": {"type": "integer", "minimum": 0, "maximum": MAX_LINE_ITEMS},
    },
    "required": ["check", "subject_id"],
    "additionalProperties": False,
}

# An approval is bound to the exact authority that granted it, exactly as a
# promotion is bound to the receipt that granted it. `"approved"` is never a
# one-word edit, and every approved proposal resolves to the artifact proving a
# human said yes.
_APPROVAL_CITES_ITS_AUTHORITY: dict[str, Any] = {
    "if": {"properties": {"state": {"const": STATE_APPROVED}}, "required": ["state"]},
    "then": {"required": ["authority_receipt_id", "decided_at"]},
}

# A proposed outward-facing action (ADR 018). Keyed on the verification receipt
# it rests on plus its kind, so re-running the generator supersedes rather than
# piling up duplicate drafts and the earlier proposal stays in history.
#
# **There is no draft body here.** The letter is rendered on demand from the
# records this cites (`dispute.render_draft`), because a dispute letter names
# the provider, the account and the amounts — free text that in an attribute
# would be tsvector-indexed and erasable only per entity (ADR 015/016, the
# binding B1/C1/C2 finding). Rendering instead of storing means erasing a
# candidate empties the draft by construction rather than by a cascade someone
# has to remember to run.
#
# `unresolved_count` is the number of verdicts on these subjects that did not
# pass and are NOT stated as points. It is on the record, and in the rendered
# draft, so an approver can never mistake "we could not check this" for "this
# is a proven error".
ACTION_PROPOSAL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "proposal_key": _SHA256,
        "kind": {"type": "string", "enum": list(PROPOSAL_KINDS)},
        "state": {"type": "string", "enum": list(PROPOSAL_STATES)},
        "document_id": _UUID,
        "verification_receipt_id": _UUID,
        "subject_ids": {"type": "array", "items": _UUID, "maxItems": MAX_IDS},
        "points": {"type": "array", "items": _POINT, "maxItems": MAX_POINTS},
        "unresolved_count": {"type": "integer", "minimum": 0},
        "authority_receipt_id": _UUID,
        "proposed_at": _TIMESTAMP,
        "decided_at": _TIMESTAMP,
        "provenance": _PROVENANCE_DIRECT,
    },
    "required": [
        "proposal_key",
        "kind",
        "state",
        "document_id",
        "verification_receipt_id",
        "subject_ids",
        "proposed_at",
        "provenance",
    ],
    "additionalProperties": False,
    "allOf": [_APPROVAL_CITES_ITS_AUTHORITY],
    "x-identity": ["proposal_key"],
    # no x-pii: ids, enums and counts only. Nothing here is a value from a
    # document, which is the whole point of not storing the draft body.
}

# What an explicit human approval mints (ADR 018): the artifact that proves a
# human said yes, to what, when, and within which limits.
#
# **No x-identity, deliberately.** Every approval is a distinct act and must
# never resolve onto an earlier one — the `execution_receipt` precedent
# (ADR 014). Nothing can merge into an authority receipt because nothing can
# match one.
#
# `granted_by` is the verified subject of the request that approved, and
# `granted_via` says how that subject was established. Both are recorded because
# this record's whole job is to be the evidence a human decided; neither is
# `x-pii` — a pseudonymous owner identifier is the same category as an event
# actor, which this repo has never flagged.
#
# `draft_digest` is sha256 over the exact text the approver read. It is what
# makes the grant specific: the gate re-renders and refuses if the draft has
# changed since. It is derived from `x-pii` amounts on the candidates, so it is
# `x-pii` too and `verify.forget_bill` cascades to it — a digest over guessable
# content is a confirmation oracle, and it must not outlive what it digests. It
# is therefore not `required`: an erased authority receipt is an honest husk
# saying "this proposal was approved by this principal at this time", and the
# gate refuses to emit against a husk rather than guessing.
AUTHORITY_RECEIPT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "proposal_id": _UUID,
        "verification_receipt_id": _UUID,
        "subject_ids": {"type": "array", "items": _UUID, "maxItems": MAX_IDS},
        "draft_digest": _SHA256,
        "granted_by": {
            "type": "string",
            "maxLength": MAX_PRINCIPAL,
            "pattern": PRINCIPAL_PATTERN,
        },
        "granted_via": {"type": "string", "enum": list(GRANT_VIAS)},
        "granted_at": _TIMESTAMP,
        "expires_at": _TIMESTAMP,
        # `minItems: 1` because an empty array is a grant that authorises
        # nothing, and a grant that authorises nothing must not be storable as
        # an authority — a reader that only checks "is there a receipt" would
        # treat it as one. `dispute.emit_draft` checks the contents too; this is
        # the write-time half of the same rule.
        "permits": {
            "type": "array",
            "items": {"type": "string", "enum": list(GRANTED_ACTS)},
            "minItems": 1,
            "maxItems": len(GRANTED_ACTS),
        },
        "channel": {"type": "string", "enum": list(CHANNELS)},
        "provenance": _PROVENANCE_DIRECT,
    },
    "required": [
        "proposal_id",
        "verification_receipt_id",
        "subject_ids",
        "granted_by",
        "granted_via",
        "granted_at",
        "expires_at",
        "permits",
        "channel",
        "provenance",
    ],
    "additionalProperties": False,
    "x-pii": ["draft_digest"],
}

BILL_PII_FIELDS: tuple[str, ...] = tuple(BILL_SCHEMA["x-pii"])
EOB_PII_FIELDS: tuple[str, ...] = tuple(EOB_SCHEMA["x-pii"])

TYPE_BILL = "bill"
TYPE_EOB = "eob"
TYPE_EXTRACTION = "bill_extraction"
TYPE_VERIFICATION = "verification_receipt"
TYPE_PROPOSAL = "action_proposal"
TYPE_AUTHORITY = "authority_receipt"

# The identity field each candidate type is keyed on, so the verifier can write
# back to the record it just judged without caring which of the two it holds.
KEY_FIELDS = {TYPE_BILL: "bill_key", TYPE_EOB: "eob_key"}

_TYPES = {
    TYPE_BILL: BILL_SCHEMA,
    TYPE_EOB: EOB_SCHEMA,
    TYPE_EXTRACTION: BILL_EXTRACTION_SCHEMA,
    TYPE_VERIFICATION: VERIFICATION_RECEIPT_SCHEMA,
    TYPE_PROPOSAL: ACTION_PROPOSAL_SCHEMA,
    TYPE_AUTHORITY: AUTHORITY_RECEIPT_SCHEMA,
}


def define_bills_types(ctx: AccessContext) -> list[str]:
    """Define any missing bills types. Idempotent; returns what it defined."""
    return define_missing(ctx, DOMAIN, _TYPES)
