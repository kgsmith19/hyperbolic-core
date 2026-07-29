"""Integration: document capture and document erasure against the kernel
(ADR 015, roadmap C1).

Tests share the session database, so every document embeds a marker unique to
its test — identical bytes are the *same* document by design.
"""

from collections.abc import Callable
from hashlib import sha256

import pytest

from domains.documents.capture import (
    MAX_UPLOAD_BYTES,
    DocumentErased,
    DocumentTextUnavailable,
    DocumentTooLarge,
    ErasureUnverified,
    UnsupportedMedia,
    capture_document,
    clean_filename,
    forget_document,
    is_document,
    read_document_text,
)
from domains.documents.storage import KIND_BYTES, BlobStore, ref_for
from domains.documents.types import (
    EXTRACTION_FAILED,
    EXTRACTION_OK,
    MIME_JPEG,
    MIME_PDF,
    MIME_PNG,
    define_documents_types,
)
from kernel import db
from kernel.access import AccessContext, ScopeError
from kernel.services import capture, find, get_entity

PdfFactory = Callable[[str], bytes]

PNG = b"\x89PNG\r\n\x1a\n" + b"documents-c1-png-marker"
CORRUPT_PDF = b"%PDF-1.7\ndocuments-c1-corrupt-marker\n" + b"\x00\xff" * 400


@pytest.fixture(scope="module")
def doc_ctx() -> AccessContext:
    """The scopes the documents path needs and nothing else."""
    ctx = AccessContext.of("documents:read", "documents:write")
    define_documents_types(ctx)
    return ctx


def event_count() -> int:
    with db.connect() as conn:
        row = conn.execute("select count(*) as n from event").fetchone()
        assert row is not None
        return int(row["n"])


def events_mentioning(needle: str) -> int:
    """Events whose payload still contains a string anywhere — the erasure bar."""
    with db.connect() as conn:
        row = conn.execute(
            "select count(*) as n from event where payload::text like %s", (f"%{needle}%",)
        ).fetchone()
        assert row is not None
        return int(row["n"])


def test_pdf_upload_stores_bytes_and_text_outside_the_entity(
    doc_ctx: AccessContext, store: BlobStore, make_pdf: PdfFactory
) -> None:
    data = make_pdf("Patient balance documentsc1alpha 128.40")
    entity_id = capture_document(
        doc_ctx, data, filename="EOB March.pdf", declared_mime=MIME_PDF, store=store
    )

    view = get_entity(doc_ctx, entity_id)
    assert view.types == ["document"]
    attributes = view.entity.attributes
    assert attributes["mime"] == MIME_PDF
    assert attributes["size_bytes"] == len(data)
    assert attributes["source"] == "upload"
    assert attributes["extraction_status"] == EXTRACTION_OK
    assert attributes["original_filename"] == "EOB March.pdf"

    # The bytes and the text are in the store, and only there.
    assert store.read(attributes["storage_ref"]) == data
    assert b"documentsc1alpha" in store.read(attributes["text_ref"])
    assert "documentsc1alpha" not in str(attributes)
    assert attributes["text_chars"] > 0


def test_document_text_never_becomes_searchable(
    doc_ctx: AccessContext, store: BlobStore, make_pdf: PdfFactory
) -> None:
    """The B1 finding, applied: `entity.search` is a tsvector over
    `attributes::text`, so text in an attribute is searchable by anything with
    read scope — including chat. A bill's text must not be reachable that way."""
    marker = "documentsc1secretdiagnosis"
    capture_document(doc_ctx, make_pdf(f"Diagnosis {marker}"), store=store)
    assert find(doc_ctx, text=marker) == []
    assert events_mentioning(marker) == 0


def test_same_bytes_resolve_to_the_same_document(
    doc_ctx: AccessContext, store: BlobStore, make_pdf: PdfFactory
) -> None:
    """Idempotency is the sha256 identity field doing its job."""
    data = make_pdf("Statement documentsc1beta")
    first = capture_document(doc_ctx, data, filename="statement.pdf", store=store)
    before = event_count()
    second = capture_document(doc_ctx, data, filename="statement-copy.pdf", store=store)
    assert second == first
    assert event_count() == before  # zero new events, not even an update


def test_image_is_stored_with_extraction_unsupported(
    doc_ctx: AccessContext, store: BlobStore
) -> None:
    entity_id = capture_document(doc_ctx, PNG, filename="bill.png", store=store)
    attributes = get_entity(doc_ctx, entity_id).entity.attributes
    assert attributes["mime"] == MIME_PNG
    assert attributes["extraction_status"] == "unsupported"
    assert "text_ref" not in attributes
    assert store.read(attributes["storage_ref"]) == PNG


def test_corrupt_pdf_is_captured_with_a_recorded_failure(
    doc_ctx: AccessContext, store: BlobStore
) -> None:
    """A malicious or broken file fails cleanly: the upload still resolves to a
    document, and the failure is a stored fact rather than a crash."""
    entity_id = capture_document(doc_ctx, CORRUPT_PDF, filename="broken.pdf", store=store)
    attributes = get_entity(doc_ctx, entity_id).entity.attributes
    assert attributes["extraction_status"] == EXTRACTION_FAILED
    assert attributes["extraction_method"] == "none"
    assert attributes["text_chars"] == 0
    assert "text_ref" not in attributes
    assert store.read(attributes["storage_ref"]) == CORRUPT_PDF


def test_oversize_upload_refused(doc_ctx: AccessContext, store: BlobStore) -> None:
    with pytest.raises(DocumentTooLarge, match="byte cap"):
        capture_document(doc_ctx, b"%PDF-" + b"x" * MAX_UPLOAD_BYTES, store=store)


def test_unknown_file_type_refused(doc_ctx: AccessContext, store: BlobStore) -> None:
    with pytest.raises(UnsupportedMedia, match="unsupported document type"):
        capture_document(doc_ctx, b"MZ\x90\x00 an executable", store=store)


def test_declared_type_must_match_the_content(doc_ctx: AccessContext, store: BlobStore) -> None:
    """A client saying "application/pdf" over PNG bytes is refused, not
    believed: C2 must never inherit a mislabelled document."""
    with pytest.raises(UnsupportedMedia, match="not application/pdf"):
        capture_document(doc_ctx, PNG, declared_mime=MIME_PDF, store=store)
    with pytest.raises(UnsupportedMedia, match="not image/jpeg"):
        capture_document(doc_ctx, PNG, declared_mime=MIME_JPEG, store=store)


def test_filename_is_display_text_not_a_path() -> None:
    assert clean_filename(r"C:\Users\owner\EOB.pdf") == "EOB.pdf"
    assert clean_filename("../../etc/passwd") == "passwd"
    assert clean_filename("bi\x00ll\n.pdf") == "bill.pdf"
    assert clean_filename("   ") is None
    assert clean_filename(None) is None


def test_capture_without_write_scope_fails_closed(
    doc_ctx: AccessContext, store: BlobStore, make_pdf: PdfFactory
) -> None:
    read_only = AccessContext.of("documents:read")
    with pytest.raises(ScopeError):
        capture_document(read_only, make_pdf("documentsc1scope"), store=store)


def test_type_definition_is_idempotent_registry_data(doc_ctx: AccessContext) -> None:
    assert define_documents_types(doc_ctx) == []


def test_is_document_only_says_yes_for_documents(
    doc_ctx: AccessContext, store: BlobStore, make_pdf: PdfFactory
) -> None:
    entity_id = capture_document(doc_ctx, make_pdf("documentsc1isdoc"), store=store)
    assert is_document(doc_ctx, entity_id) is True


def test_read_document_text_is_the_seam_other_domains_use(
    doc_ctx: AccessContext, store: BlobStore, make_pdf: PdfFactory
) -> None:
    """C2 needs the extracted text and must not open the blob store itself."""
    entity_id = capture_document(doc_ctx, make_pdf("Balance documentsc1seam 42.00"), store=store)
    assert "documentsc1seam" in read_document_text(doc_ctx, entity_id, store=store)


def test_read_document_text_refuses_when_there_is_no_text(
    doc_ctx: AccessContext, store: BlobStore
) -> None:
    """An image is stored but never read (extraction_status "unsupported"), so
    there is nothing to hand C2 — say so rather than returning an empty string
    a caller would treat as an empty bill."""
    entity_id = capture_document(doc_ctx, PNG, filename="bill.png", store=store)
    with pytest.raises(DocumentTextUnavailable, match="no extracted text"):
        read_document_text(doc_ctx, entity_id, store=store)


def test_read_document_text_needs_read_scope(
    doc_ctx: AccessContext, store: BlobStore, make_pdf: PdfFactory
) -> None:
    entity_id = capture_document(doc_ctx, make_pdf("documentsc1textscope"), store=store)
    with pytest.raises(ScopeError):
        read_document_text(AccessContext.of("calendar:read"), entity_id, store=store)


def test_partial_field_erasure_is_refused(
    doc_ctx: AccessContext, store: BlobStore, make_pdf: PdfFactory
) -> None:
    entity_id = capture_document(
        doc_ctx, make_pdf("documentsc1partial"), filename="p.pdf", store=store
    )
    with pytest.raises(ValueError, match="all-or-nothing"):
        forget_document(doc_ctx, entity_id, fields=["original_filename"], store=store)


def test_read_only_context_cannot_destroy_the_blobs(
    doc_ctx: AccessContext, store: BlobStore, make_pdf: PdfFactory
) -> None:
    """Deleting a blob is irreversible — blobs are not in the nightly pg_dump —
    and `BlobStore` takes no AccessContext, so the write check has to happen
    before the filesystem is touched. A `documents:read` token's whole
    guarantee is that it cannot destroy anything."""
    entity_id = capture_document(
        doc_ctx, make_pdf("documentsc1readonly"), filename="ro.pdf", store=store
    )
    attributes = get_entity(doc_ctx, entity_id).entity.attributes
    read_only = AccessContext.of("documents:read")

    with pytest.raises(ScopeError):
        forget_document(read_only, entity_id, store=store)

    assert store.read(attributes["storage_ref"])  # the bill survived the attempt
    assert store.read(attributes["text_ref"])
    assert "erased_at" not in get_entity(doc_ctx, entity_id).entity.attributes


def test_erasure_refuses_when_a_ref_names_no_blob(
    doc_ctx: AccessContext, store: BlobStore, make_pdf: PdfFactory
) -> None:
    """Pointers can drift — `POST /capture` accepts `type_name: "document"` and
    the resolver merges on sha256 — and an erasure that deletes nothing must
    never return success. Same failure class as the B1 erasure bug."""
    data = make_pdf("documentsc1dangling")
    entity_id = capture_document(doc_ctx, data, filename="dangling.pdf", store=store)
    attributes = dict(get_entity(doc_ctx, entity_id).entity.attributes)
    real_ref = attributes["storage_ref"]
    # a well-formed ref for bytes this store has never held
    dangling = ref_for(sha256(b"documentsc1 never stored").hexdigest(), KIND_BYTES)
    capture(doc_ctx, "document", {**attributes, "storage_ref": dangling})

    with pytest.raises(ErasureUnverified, match="refusing to report an erasure"):
        forget_document(doc_ctx, entity_id, store=store)

    # refused before writing anything: no tombstone, and the real bill is still
    # there for an operator to reconnect
    assert "erased_at" not in get_entity(doc_ctx, entity_id).entity.attributes
    assert store.read(real_ref) == data


@pytest.fixture(scope="module")
def erasable(make_pdf: PdfFactory) -> bytes:
    """One document built once, so the erasure test and the re-upload test are
    provably talking about the same bytes."""
    return make_pdf("Balance documentsc1erasedtext 900.00")


# The erasure regression. Runs last: it destroys blobs the earlier tests read.
def test_forget_removes_the_filename_the_bytes_and_the_text(
    doc_ctx: AccessContext, store: BlobStore, erasable: bytes
) -> None:
    filename = "EOB documentsc1erasee 2026-03.pdf"
    entity_id = capture_document(doc_ctx, erasable, filename=filename, store=store)
    attributes = get_entity(doc_ctx, entity_id).entity.attributes
    storage_ref, text_ref = attributes["storage_ref"], attributes["text_ref"]
    assert entity_id in {e.id for e in find(doc_ctx, text="documentsc1erasee")}  # not vacuous
    assert store.read(text_ref)

    result = forget_document(doc_ctx, entity_id, store=store)

    assert result.fields == ["original_filename"]
    # the count backs the claim: a caller can verify the files went, not just
    # that the call returned
    assert result.blobs_deleted == 2
    # 1. gone from live state and from full-text search everywhere
    assert "original_filename" not in get_entity(doc_ctx, entity_id).entity.attributes
    assert find(doc_ctx, text="documentsc1erasee") == []
    # 2. gone from every event payload that ever recorded it
    assert events_mentioning("documentsc1erasee") == 0
    # 3. gone from the blob store: the bill itself, and its extracted text
    with pytest.raises(FileNotFoundError):
        store.read(storage_ref)
    with pytest.raises(FileNotFoundError):
        store.read(text_ref)
    assert events_mentioning("documentsc1erasedtext") == 0


def test_erasing_an_already_erased_document_is_refused_not_reported_as_success(
    doc_ctx: AccessContext, store: BlobStore, erasable: bytes
) -> None:
    """A second erasure deletes nothing, so it must not return 200 — but it is
    a different fact from drifted pointers and says so."""
    (document,) = find(
        doc_ctx, type_name="document", filters={"sha256": sha256(erasable).hexdigest()}
    )
    with pytest.raises(DocumentErased, match="already erased"):
        forget_document(doc_ctx, document.id, store=store)


def test_erased_document_is_not_reinstated_by_re_uploading_the_same_bytes(
    doc_ctx: AccessContext, store: BlobStore, erasable: bytes
) -> None:
    """The ADR 012 "Durable erasure" failure in its upload form: the owner
    still holds the file, so a re-upload would silently re-store what they
    asked us to destroy. It is refused, loudly."""
    documents_before = {d.id for d in find(doc_ctx, type_name="document")}
    with pytest.raises(DocumentErased, match="refused"):
        capture_document(doc_ctx, erasable, filename="again.pdf", store=store)
    assert {d.id for d in find(doc_ctx, type_name="document")} == documents_before
    assert find(doc_ctx, text="again.pdf") == []


def test_erased_document_text_cannot_be_read_back(
    doc_ctx: AccessContext, store: BlobStore, erasable: bytes
) -> None:
    """The other half of that rule: erasure must also close the read seam C2
    uses, or a later extraction run would quote a destroyed bill."""
    (document,) = find(
        doc_ctx, type_name="document", filters={"sha256": sha256(erasable).hexdigest()}
    )
    with pytest.raises(DocumentErased, match="was erased"):
        read_document_text(doc_ctx, document.id, store=store)
