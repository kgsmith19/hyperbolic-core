"""Document capture and document erasure (ADR 015, roadmap C1).

Upload -> size cap -> sniffed MIME -> sha256 -> bytes in the blob store ->
text extracted into the blob store -> one `document` entity holding refs and
identity. This slice does not parse bills, call a model, or create bill/EOB
entities: that is C2. There is no outbound request anywhere in this path, so
the B1 SSRF redirect rule has nothing to apply to here.

Idempotency is the identity field doing its job: the same bytes hash to the
same `sha256`, so a re-upload resolves to the existing entity and emits no new
event at all.

Erasure is the reason this module exists rather than a `POST /capture` call.
`forget()` is a kernel service over entity attributes and event payloads; it
knows nothing about a file on disk. `forget_document` is the whole erasure:
blobs unlinked, a durable `erased_at` tombstone captured, then the kernel
redaction over every event that ever mentioned the entity — in that order, so
the tombstone's own event is redacted too. The tombstone is what stops erasure
from silently undoing itself: re-uploading the same bytes afterwards is
refused, instead of quietly re-storing the file the owner asked us to destroy
(the ADR 012 "Durable erasure" failure shape, in its upload form).
"""

import logging
import re
from datetime import UTC, datetime
from hashlib import sha256
from typing import Any
from uuid import UUID

from domains.documents.extract import extract_text
from domains.documents.storage import KIND_BYTES, KIND_TEXT, BlobStore
from domains.documents.types import (
    ACCEPTED_MIMES,
    DOMAIN,
    MAX_FILENAME,
    MIME_JPEG,
    MIME_PDF,
    MIME_PNG,
    PII_FIELDS,
    SOURCE_UPLOAD,
    define_documents_types,
)
from kernel import services
from kernel.access import AccessContext, require
from kernel.events import DEFAULT_ACTOR
from kernel.services import ForgetResult

log = logging.getLogger("lifeos.documents")

TYPE_NAME = "document"
METHOD = "domains.documents.capture"

MAX_UPLOAD_BYTES = 10 * 1024 * 1024

# Content sniffing, not the client's word: a declared content-type is caller
# input and an upload named `bill.pdf` full of something else must not become
# a "pdf" that C2 later trusts.
_MAGIC = (
    (b"%PDF-", MIME_PDF),
    (b"\x89PNG\r\n\x1a\n", MIME_PNG),
    (b"\xff\xd8\xff", MIME_JPEG),
)
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


class UnsupportedMedia(ValueError):
    """The upload is not one of the accepted document types."""


class DocumentTooLarge(ValueError):
    """The upload exceeds the size cap."""


class DocumentErased(ValueError):
    """These exact bytes were erased; re-uploading them would undo that."""


class DocumentCaptureRefused(ValueError):
    """A generic capture tried to write a document record, or to merge into
    one through its identity field."""


class ErasureUnverified(RuntimeError):
    """The store and the entity's pointers disagree, so an erasure cannot be
    reported as complete. Not client input — the system is inconsistent."""


class DocumentTextUnavailable(ValueError):
    """This document has no extracted text to read (never extracted, extraction
    failed, or the blob is gone)."""


class DocumentForgetResult(ForgetResult):
    """A `ForgetResult` that also accounts for the blobs, so a caller can
    verify the file is gone instead of taking the 200 on trust."""

    blobs_deleted: int


def sniff_mime(data: bytes, declared: str | None = None) -> str:
    """The MIME type of ``data`` by magic bytes. A declared type that
    contradicts the content is refused rather than ignored."""
    mime = next((m for magic, m in _MAGIC if data.startswith(magic)), None)
    if mime is None:
        raise UnsupportedMedia(f"unsupported document type; accepted: {', '.join(ACCEPTED_MIMES)}")
    stated = (declared or "").split(";")[0].strip().lower()
    if stated in ACCEPTED_MIMES and stated != mime:
        raise UnsupportedMedia(f"content is not {stated}")
    return mime


def clean_filename(filename: str | None) -> str | None:
    """A filename is display text, never a path: strip directory parts and
    control characters, bound the length. It is stored as PII and used for
    nothing else — blob keys come from the digest (`storage.py`)."""
    if not filename:
        return None
    name = _CONTROL_CHARS.sub("", filename.replace("\\", "/").rsplit("/", 1)[-1]).strip()
    return name[:MAX_FILENAME] or None


def capture_document(
    ctx: AccessContext,
    data: bytes,
    filename: str | None = None,
    declared_mime: str | None = None,
    source: str = SOURCE_UPLOAD,
    store: BlobStore | None = None,
) -> UUID:
    """Store one uploaded document and return its entity id.

    Re-uploading identical bytes returns the existing entity untouched.

    Write scope is required **first**, before anything is persisted. This
    function writes blobs before the entity capture, and `BlobStore` takes no
    AccessContext — relying on the scope check inside `services.capture` would
    let a `documents:read` token write files onto the box (the
    `forget_document` rule, pointed at the write path).
    """
    require(ctx, f"{DOMAIN}:write")
    if len(data) > MAX_UPLOAD_BYTES:
        raise DocumentTooLarge(f"document exceeds the {MAX_UPLOAD_BYTES} byte cap")
    mime = sniff_mime(data, declared_mime)
    digest = sha256(data).hexdigest()

    define_documents_types(ctx)
    existing = services.find(ctx, type_name=TYPE_NAME, filters={"sha256": digest})
    if existing:
        if "erased_at" in existing[0].attributes:
            raise DocumentErased(
                "these bytes were erased from this system; re-uploading them is refused"
            )
        return existing[0].id  # same bytes, same document: zero new events

    store = store or BlobStore()
    extraction = extract_text(data, mime)
    attributes: dict[str, Any] = {
        "sha256": digest,
        "mime": mime,
        "size_bytes": len(data),
        "uploaded_at": datetime.now(UTC).isoformat(),
        "source": source,
        "storage_ref": store.put(digest, KIND_BYTES, data),
        "extraction_status": extraction.status,
        "extraction_method": extraction.method,
        "text_chars": len(extraction.text),
        "text_truncated": extraction.truncated,
    }
    if extraction.text:
        attributes["text_ref"] = store.put(digest, KIND_TEXT, extraction.text.encode())
    cleaned = clean_filename(filename)
    if cleaned:
        attributes["original_filename"] = cleaned
    try:
        return services.capture(ctx, TYPE_NAME, attributes, actor=METHOD).entity_id
    except BaseException:
        # A capture that fails here would strand the blobs just written outside
        # every erasure path: the entity holding the refs was never created.
        # Unlink them — safe, because the `find` above proved no other entity
        # holds this digest — then let the failure surface.
        for key in ("storage_ref", "text_ref"):
            ref = attributes.get(key)
            if isinstance(ref, str):
                store.delete(ref)
        raise


# The identity field `document` is keyed on. Entity resolution matches on the
# identity field *name* across every type declaring it, so a payload carrying
# this key is what makes a capture land on a document record, whatever type the
# payload claims to be (the bills OWNED_KEYS precedent, ADR 017).
IDENTITY_KEY = "sha256"


def guard_capture(type_name: str, attributes: dict[str, Any]) -> None:
    """Refuse a `POST /capture` that would land on a document record.

    Mirrors `domains.bills.verify.guard_capture`, and in the same order: the
    lock is on the record the write would land on, not on the type name it
    claims. `ExactIdentityResolver` matches on the identity field *name* across
    every type that declares it, and `capture` validates the *incoming* payload
    against the *incoming* type's schema before merging — so a fresh type
    declaring `x-identity: ["sha256"]` could carry a real document's digest,
    never meet `DOCUMENT_SCHEMA`, and replace `storage_ref`/`text_ref` with
    dangling refs or forge `erased_at` onto the real document.

    And `document` itself is never a generic capture: its records are written
    by `capture_document` (`POST /documents`), which is what puts the bytes the
    refs point at into the store, and by `forget_document`, which is the only
    thing entitled to write a tombstone.
    """
    if IDENTITY_KEY in attributes and type_name != TYPE_NAME:
        raise DocumentCaptureRefused(
            f"'{IDENTITY_KEY}' is the identity field of '{TYPE_NAME}'; a capture of "
            f"'{type_name}' carrying it would merge into that record"
        )
    if type_name == TYPE_NAME:
        raise DocumentCaptureRefused(
            "'document' records are written by the upload path (POST /documents) "
            "and the erasure path, never by a direct capture"
        )


def is_document(ctx: AccessContext, entity_id: UUID) -> bool:
    return TYPE_NAME in services.get_entity(ctx, entity_id).types


def read_document_text(ctx: AccessContext, entity_id: UUID, store: BlobStore | None = None) -> str:
    """The extracted text of one document, read from the blob store.

    The blob store is this cell's private business: it takes no AccessContext,
    its keys are re-validated here, and a ref that came back out of the
    database is not trusted until it does. Another domain that needs a
    document's text asks through this function — never by constructing a
    `BlobStore` of its own (ADR 015, invariant 7 in spirit).

    Read scope is required, and an erased document stays erased: `erased_at`
    survives `forget()` precisely so a later reader cannot resurrect content
    the owner asked us to destroy.
    """
    require(ctx, f"{DOMAIN}:read")
    view = services.get_entity(ctx, entity_id)
    if TYPE_NAME not in view.types:
        raise ValueError(f"entity {entity_id} is not a document")
    attributes = view.entity.attributes
    if "erased_at" in attributes:
        raise DocumentErased(f"document {entity_id} was erased; its text is gone")
    ref = attributes.get("text_ref")
    if not isinstance(ref, str):
        # The status is an enum this module wrote, never document content.
        raise DocumentTextUnavailable(
            f"document {entity_id} has no extracted text "
            f"(extraction_status: {attributes.get('extraction_status')})"
        )
    store = store or BlobStore()
    if not store.exists(ref):
        raise DocumentTextUnavailable(f"document {entity_id} points at a text blob that is gone")
    # `errors="replace"` because the bytes came from a parser reading a hostile
    # file: an undecodable byte must not raise out of a read path.
    return store.read(ref).decode("utf-8", errors="replace")


def forget_document(
    ctx: AccessContext,
    entity_id: UUID,
    fields: list[str] | None = None,
    actor: str = DEFAULT_ACTOR,
    store: BlobStore | None = None,
) -> DocumentForgetResult:
    """Erase a document completely: stored bytes, extracted text, attributes
    and every event payload that ever mentioned it.

    All-or-nothing on purpose. Most of a document's personal data is in the
    file, not in the entity, so a partial field redaction would leave the bill
    on disk while reporting an erasure.

    Deleting a blob is destructive and irreversible — blobs are not in the
    nightly `pg_dump` — so write scope is required *first*, before this
    function touches the filesystem at all. `BlobStore` takes no AccessContext
    and cannot check anything; relying on the scope check inside a later
    `capture` would let a `documents:read` token destroy the file and only then
    be refused.

    Every step is verified rather than attempted. A ref that names no file
    means the pointer and the store disagree, and an erasure that deleted
    nothing must never return 200 — that is the B1 failure ("erasure silently
    undid itself") wearing a different costume.
    """
    if fields is not None:
        raise ValueError("document erasure is all-or-nothing: omit `fields`")
    require(ctx, f"{DOMAIN}:write")

    view = services.get_entity(ctx, entity_id)
    if TYPE_NAME not in view.types:
        raise ValueError(f"entity {entity_id} is not a document")
    attributes = view.entity.attributes
    if "storage_ref" not in attributes:
        raise ErasureUnverified(f"document {entity_id} has no storage_ref; nothing to erase from")

    store = store or BlobStore()
    refs = [attributes[key] for key in ("storage_ref", "text_ref") if key in attributes]
    absent = [ref for ref in refs if not store.exists(ref)]
    tombstoned = "erased_at" in attributes
    if absent and len(absent) == len(refs) and tombstoned:
        # Already fully erased. Distinct from drift, and distinct from success:
        # this call deleted nothing and says so.
        raise DocumentErased(f"document {entity_id} was already erased")
    if absent and not tombstoned:
        # Checked before anything is written or unlinked, so a document whose
        # pointers have drifted is left exactly as it was for an operator to
        # look at, rather than tombstoned with its bill still on disk.
        raise ErasureUnverified(
            f"document {entity_id} points at {len(absent)} blob(s) that are not in the store; "
            "refusing to report an erasure that deleted nothing"
        )
    if absent:
        # The tombstone is set and only some blobs are gone: a prior erasure
        # crashed between the unlinks (the tombstone lands before them). A
        # retry after a mid-erasure failure must still be able to finish the
        # job (ADR 015), so RESUME — delete the survivors below — rather than
        # refusing forever and leaving a blob no erasure path can reach.
        refs = [ref for ref in refs if ref not in absent]

    if not tombstoned:
        # The tombstone repeats the entity's non-PII attributes because
        # `capture` validates the dict it is handed against the whole schema,
        # not the merged result. It drops the PII outright, and it lands
        # *before* the redaction so that even so, forget() scrubs this event
        # too. A resumed erasure already has its tombstone and skips this.
        tombstone = {k: v for k, v in attributes.items() if k not in PII_FIELDS}
        tombstone["erased_at"] = datetime.now(UTC).isoformat()
        services.capture(ctx, TYPE_NAME, tombstone, actor=METHOD)

    deleted = 0
    for ref in refs:
        if not store.delete(ref):  # vanished between the check and here
            raise ErasureUnverified(f"blob {ref} disappeared mid-erasure; erasure is unverified")
        deleted += 1
    log.info("document %s: deleted %d blob(s)", entity_id, deleted)

    result = services.forget(ctx, entity_id, actor=actor)
    return DocumentForgetResult(**result.model_dump(), blobs_deleted=deleted)
