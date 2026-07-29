"""Document types as registry data (invariant 1, ADR 015). Zero kernel DDL.

A `document` entity is a *pointer plus identity*, never a copy of the file.
The bytes and the extracted text live in the blob store (`storage.py`); the
entity carries `sha256`, a `storage_ref`, an optional `text_ref` and the
metadata needed to reason about the file. That split is not tidiness — it is
the erasure path. `entity.search` is a generated tsvector over
`attributes::text` and `forget()` is strictly per-entity, so a medical bill's
text placed in an attribute would stay full-text searchable (reachable through
chat, which reads every active domain) and could never be removed from the
places it leaked to (ADR 012/013/014 all found the same edge).

The type is `x-sensitive` (ADR 016): `original_filename` is PHI in the graph,
so the shared agent-tool surface withholds this domain from both LLM doors.

`sha256` is the identity field and is deliberately not `x-pii`: `forget()`
strips PII, so keying on an erasable field makes an erased entity unfindable
and the next upload of the same bytes mints a brand-new entity carrying the
same content (ADR 012 "Durable erasure"). `original_filename` — which routinely
reads `EOB_Jane_Doe_2026-03.pdf` — is PII and *is* flagged.
"""

from typing import Any

from kernel.access import AccessContext
from kernel.services import define_missing

DOMAIN = "documents"

MIME_PDF = "application/pdf"
MIME_PNG = "image/png"
MIME_JPEG = "image/jpeg"
ACCEPTED_MIMES = (MIME_PDF, MIME_PNG, MIME_JPEG)

SOURCE_UPLOAD = "upload"
SOURCES = (SOURCE_UPLOAD,)

EXTRACTION_OK = "ok"
EXTRACTION_FAILED = "failed"
EXTRACTION_UNSUPPORTED = "unsupported"
EXTRACTION_STATUSES = (EXTRACTION_OK, EXTRACTION_FAILED, EXTRACTION_UNSUPPORTED)

MAX_FILENAME = 255

_SHA256 = {"type": "string", "minLength": 64, "maxLength": 64, "pattern": "^[0-9a-f]{64}$"}
_TIMESTAMP = {"type": "string", "maxLength": 64}
# `<first two hex>/<digest>.<bin|txt>` — the store's own key space, so a ref
# read back out of the database can never address a path outside it.
_BLOB_REF = {
    "type": "string",
    "maxLength": 128,
    "pattern": "^[0-9a-f]{2}/[0-9a-f]{64}\\.(bin|txt)$",
}

DOCUMENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "sha256": _SHA256,
        "mime": {"type": "string", "enum": list(ACCEPTED_MIMES)},
        "size_bytes": {"type": "integer", "minimum": 0},
        "uploaded_at": _TIMESTAMP,
        "source": {"type": "string", "enum": list(SOURCES)},
        "storage_ref": _BLOB_REF,
        "text_ref": _BLOB_REF,
        "text_chars": {"type": "integer", "minimum": 0},
        "text_truncated": {"type": "boolean"},
        "extraction_status": {"type": "string", "enum": list(EXTRACTION_STATUSES)},
        # A library name, never an exception message: a parser error can quote
        # the document it choked on (invariant 9, ADR 012/014).
        "extraction_method": {"type": "string", "maxLength": 32},
        "original_filename": {"type": "string", "maxLength": MAX_FILENAME},
        # Set when the bytes and text have been deleted from the blob store.
        # Not x-pii on purpose: the tombstone must survive forget(), or the
        # next upload of the same bytes would silently reinstate an erasure.
        "erased_at": _TIMESTAMP,
    },
    # `original_filename` is x-pii, so it cannot be required: an erased
    # document must still be a valid document.
    "required": [
        "sha256",
        "mime",
        "size_bytes",
        "uploaded_at",
        "source",
        "storage_ref",
        "extraction_status",
    ],
    "additionalProperties": False,
    "x-identity": ["sha256"],
    "x-pii": ["original_filename"],
    # Withheld from the shared agent-tool surface (ADR 016). C1 reasoned that
    # documents were safe to expose to chat because the bytes and the text are
    # not in the graph — but `original_filename` is, and it routinely reads
    # `EOB_Jane_Doe_2026-03.pdf`. That is the same PHI the `bills` types are
    # flagged for, one hop earlier and with no extraction run to record it, so
    # the flag belongs here too. Enforcement is domain-shaped, so this withholds
    # the whole `documents` domain from both LLM doors.
    "x-sensitive": True,
}

PII_FIELDS: tuple[str, ...] = tuple(DOCUMENT_SCHEMA["x-pii"])

_TYPES = {"document": DOCUMENT_SCHEMA}


def define_documents_types(ctx: AccessContext) -> list[str]:
    """Define any missing documents types. Idempotent; returns what it defined."""
    return define_missing(ctx, DOMAIN, _TYPES)
