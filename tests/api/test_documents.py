"""e2e: POST /documents, the document-aware forget route, and the capture-door
guard for document records (ADR 015, C1)."""

import json
import os
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import UUID

import pymupdf
import pytest
from fastapi.testclient import TestClient

from api.auth import authenticate
from api.main import app
from domains.bills.extract import extract_document
from domains.documents.capture import MAX_UPLOAD_BYTES
from domains.documents.storage import BlobStore
from kernel.access import AccessContext

client = TestClient(app)

PNG = b"\x89PNG\r\n\x1a\napi-c1-png"


@pytest.fixture(scope="module", autouse=True)
def blob_root(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Path]:
    """The route builds its own store from the environment; point it at a
    temporary root so a test run never writes to the deploy box's blobs."""
    root = tmp_path_factory.mktemp("api-blobs")
    previous = os.environ.get("LIFEOS_BLOB_ROOT")
    os.environ["LIFEOS_BLOB_ROOT"] = str(root)
    yield root
    if previous is None:
        del os.environ["LIFEOS_BLOB_ROOT"]
    else:
        os.environ["LIFEOS_BLOB_ROOT"] = previous


@pytest.fixture(scope="module")
def bill(seeded: object) -> bytes:
    with pymupdf.open() as doc:
        doc.new_page().insert_text((72, 72), "Amount due apic1marker 74.20")
        return bytes(doc.tobytes())


def upload(data: bytes, filename: str, content_type: str) -> Any:
    return client.post("/documents", files={"file": (filename, data, content_type)})


def test_upload_returns_the_document_entity(bill: bytes, blob_root: Path) -> None:
    response = upload(bill, "March EOB.pdf", "application/pdf")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["types"] == ["document"]
    attributes = body["entity"]["attributes"]
    assert attributes["mime"] == "application/pdf"
    assert attributes["size_bytes"] == len(bill)
    assert attributes["original_filename"] == "March EOB.pdf"
    assert attributes["extraction_status"] == "ok"

    store = BlobStore(blob_root)
    assert store.read(attributes["storage_ref"]) == bill
    assert b"apic1marker" in store.read(attributes["text_ref"])
    assert "apic1marker" not in str(attributes)  # text never enters the entity


def test_re_uploading_the_same_bytes_returns_the_same_document(bill: bytes) -> None:
    first = upload(bill, "March EOB.pdf", "application/pdf").json()["entity"]["id"]
    second = upload(bill, "a-copy.pdf", "application/pdf").json()["entity"]["id"]
    assert second == first


def test_image_upload_is_accepted(seeded: object) -> None:
    response = upload(PNG, "bill.png", "image/png")
    assert response.status_code == 200, response.text
    assert response.json()["entity"]["attributes"]["extraction_status"] == "unsupported"


def test_unsupported_file_type_is_refused(seeded: object) -> None:
    response = upload(b"MZ\x90\x00 executable", "payload.exe", "application/octet-stream")
    assert response.status_code == 415
    assert "unsupported document type" in response.json()["detail"]


def test_declared_type_that_contradicts_the_content_is_refused(seeded: object) -> None:
    response = upload(PNG, "bill.pdf", "application/pdf")
    assert response.status_code == 415


def test_oversize_upload_is_refused_before_the_body_is_parsed(seeded: object) -> None:
    """The declared Content-Length gate: nothing is parsed or stored."""
    response = upload(
        b"%PDF-" + b"x" * (MAX_UPLOAD_BYTES + 1024 * 1024), "big.pdf", "application/pdf"
    )
    assert response.status_code == 413
    assert response.json()["detail"].startswith("declared body exceeds")  # the middleware gate


def test_upload_just_over_the_cap_is_refused_by_the_counted_read(seeded: object) -> None:
    """Under the multipart slack the middleware lets it through; the counted
    read in the route is the gate that actually holds the cap."""
    response = upload(b"%PDF-" + b"x" * (MAX_UPLOAD_BYTES - 4), "just-over.pdf", "application/pdf")
    assert response.status_code == 413
    assert response.json()["detail"].startswith("document exceeds")  # the counted-read gate


def test_upload_requires_a_file(seeded: object) -> None:
    assert client.post("/documents").status_code == 422


def test_forget_route_erases_the_stored_bytes_too(blob_root: Path) -> None:
    """The generic erasure endpoint must not under-erase a document: the
    filename goes, and so do the file and its extracted text."""
    with pymupdf.open() as doc:
        doc.new_page().insert_text((72, 72), "Balance apic1erasedtext 12.00")
        data = bytes(doc.tobytes())
    body = upload(data, "apic1erasee statement.pdf", "application/pdf").json()
    entity_id = body["entity"]["id"]
    attributes = body["entity"]["attributes"]
    store = BlobStore(blob_root)
    assert store.read(attributes["storage_ref"]) == data  # not vacuous
    findable = client.get("/search", params={"text": "apic1erasee"}).json()
    assert entity_id in {e["id"] for e in findable}  # nor is the search assertion

    erased = client.post(f"/entities/{entity_id}/forget", json={})
    assert erased.status_code == 200, erased.text
    assert erased.json()["fields"] == ["original_filename"]
    # the response backs its own claim: two blobs verifiably gone
    assert erased.json()["blobs_deleted"] == 2

    view = client.get(f"/entities/{entity_id}").json()
    assert "original_filename" not in view["entity"]["attributes"]
    assert client.get("/search", params={"text": "apic1erasee"}).json() == []
    for ref in (attributes["storage_ref"], attributes["text_ref"]):
        with pytest.raises(FileNotFoundError):
            store.read(ref)

    # ...and the same bytes cannot be quietly re-uploaded afterwards
    assert upload(data, "apic1erasee statement.pdf", "application/pdf").status_code == 409


def test_partial_field_erasure_of_a_document_is_refused(bill: bytes) -> None:
    entity_id = upload(bill, "March EOB.pdf", "application/pdf").json()["entity"]["id"]
    response = client.post(f"/entities/{entity_id}/forget", json={"fields": ["original_filename"]})
    assert response.status_code == 422
    assert "all-or-nothing" in response.json()["detail"]


def _fake_extraction_client(payload: dict[str, Any]) -> Any:
    """The bills fixtures' fake-model shape (tests/bills/test_bill_extraction):
    the `client.beta.messages.create(**kw)` surface, scripted, no network."""

    def create(**kwargs: Any) -> Any:
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=json.dumps(payload))],
            stop_reason="end_turn",
        )

    return SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=create)))


def test_forgetting_a_document_cascades_to_the_candidates_extracted_from_it(
    seeded: object, blob_root: Path
) -> None:
    """The under-erasure regression: `forget()` is per-entity and
    `forget_document` sees only the document, so the bill/eob candidates
    extracted from it — issuer, refs, dates, amounts, live and
    tsvector-searchable — used to survive the one erasure endpoint. The route
    now cascades through the bills forget path and reports what it erased."""
    marker = "apicascade"
    issuer_marker = "apicascadeissuer"  # only ever exists in the candidates
    with pymupdf.open() as doc:
        doc.new_page().insert_text((72, 72), f"Mercy Clinic statement {marker} due 128.40")
        data = bytes(doc.tobytes())
    document_id = upload(data, f"{marker} statement.pdf", "application/pdf").json()["entity"]["id"]
    payload = {
        "bills": [
            {
                "category": "medical",
                "issuer": f"Mercy Clinic {issuer_marker}",
                "account_ref": f"ACCT-{marker}",
                "service_date": "2026-03-04",
                "due_date": "2026-04-01",
                "currency": "USD",
                "total": "128.40",
                "line_items": [{"code": "99213", "quantity": "1", "amount": "128.40"}],
                "confidence": 0.8,
                "low_confidence_fields": [],
            }
        ],
        "eobs": [
            {
                "payer": f"Blue Shield {issuer_marker}",
                "claim_no": f"CLM-{marker}",
                "service_date": "2026-03-04",
                "currency": "USD",
                "line_items": [
                    {
                        "code": "99213",
                        "quantity": "1",
                        "billed": "128.40",
                        "allowed": "90.00",
                        "plan_paid": "72.00",
                        "patient_resp": "18.00",
                    }
                ],
                "confidence": 0.8,
                "low_confidence_fields": [],
            }
        ],
    }
    extract_document(
        AccessContext.of("bills:read", "bills:write", "documents:read"),
        UUID(document_id),
        client=_fake_extraction_client(payload),
    )
    findable = client.get("/search", params={"text": issuer_marker}).json()
    assert len(findable) == 2  # one bill + one eob, live and searchable: not vacuous
    candidate_ids = [e["id"] for e in findable]

    # A doomed partial-fields request is refused BEFORE the cascade runs:
    # a 422 must erase nothing anywhere.
    refused = client.post(f"/entities/{document_id}/forget", json={"fields": ["sha256"]})
    assert refused.status_code == 422
    assert len(client.get("/search", params={"text": issuer_marker}).json()) == 2

    response = client.post(f"/entities/{document_id}/forget", json={})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["candidates_erased"] == 2  # the response reports the cascade
    assert body["receipts_redacted"] == 0  # nothing was verified; still reported
    assert body["blobs_deleted"] == 2
    assert client.get("/search", params={"text": issuer_marker}).json() == []
    for candidate_id in candidate_ids:
        attributes = client.get(f"/entities/{candidate_id}").json()["entity"]["attributes"]
        assert "issuer" not in attributes and "payer" not in attributes
        assert "line_items" not in attributes and "total" not in attributes


def test_a_context_that_cannot_see_candidates_cannot_erase_their_document(
    seeded: object, blob_root: Path
) -> None:
    """The fail-open regression: the cascade used to gate on `list_types`,
    which filters by scope — so a documents-only context skipped the bills arm
    silently, erased the document, and reported `candidates_erased: 0` on a
    200, leaving the extracted PHI live and the cascade unretryable (the
    document is tombstoned). The refusal must come first and erase nothing."""
    marker = "apiscoped"
    issuer_marker = "apiscopedissuer"  # only ever exists in the candidate
    with pymupdf.open() as doc:
        doc.new_page().insert_text((72, 72), f"Mercy Clinic statement {marker} due 128.40")
        data = bytes(doc.tobytes())
    document_id = upload(data, f"{marker} statement.pdf", "application/pdf").json()["entity"]["id"]
    payload = {
        "bills": [
            {
                "category": "medical",
                "issuer": f"Mercy Clinic {issuer_marker}",
                "account_ref": f"ACCT-{marker}",
                "service_date": "2026-03-04",
                "due_date": "2026-04-01",
                "currency": "USD",
                "total": "128.40",
                "line_items": [{"code": "99213", "quantity": "1", "amount": "128.40"}],
                "confidence": 0.8,
                "low_confidence_fields": [],
            }
        ],
        "eobs": [],
    }
    extract_document(
        AccessContext.of("bills:read", "bills:write", "documents:read"),
        UUID(document_id),
        client=_fake_extraction_client(payload),
    )
    assert len(client.get("/search", params={"text": issuer_marker}).json()) == 1

    app.dependency_overrides[authenticate] = lambda: AccessContext.of(
        "documents:read", "documents:write"
    )
    try:
        refused = client.post(f"/entities/{document_id}/forget", json={})
    finally:
        del app.dependency_overrides[authenticate]

    assert refused.status_code == 403, refused.text
    # Nothing was erased anywhere: the candidate is still searchable, the
    # document still holds its bytes, and no tombstone was forged.
    assert len(client.get("/search", params={"text": issuer_marker}).json()) == 1
    attributes = client.get(f"/entities/{document_id}").json()["entity"]["attributes"]
    assert "erased_at" not in attributes
    assert BlobStore(blob_root).exists(attributes["storage_ref"])


def test_generic_capture_of_a_document_is_refused(seeded: object) -> None:
    """`POST /capture` landing on `document` records would mint entities whose
    refs point at nothing the upload path wrote; they are written by
    POST /documents and the erasure path only."""
    response = client.post(
        "/capture",
        json={"type_name": "document", "attributes": {"sha256": "00" * 32}},
    )
    assert response.status_code == 422, response.text
    assert "POST /documents" in response.json()["detail"]


def test_a_type_aliasing_the_document_identity_field_cannot_merge_into_a_document(
    bill: bytes, blob_root: Path
) -> None:
    """The `bill_key_alias` attack (tests/api/test_bill_promotion.py), aimed at
    documents: entity resolution matches on the identity field NAME across
    every type declaring it, so a foreign type with `x-identity: ["sha256"]`
    carrying a real document's digest would merge into the real document —
    able to replace `storage_ref`/`text_ref` with dangling refs or forge
    `erased_at`, never meeting `document`'s own schema."""
    uploaded = upload(bill, "March EOB.pdf", "application/pdf").json()
    document_id = uploaded["entity"]["id"]
    digest = uploaded["entity"]["attributes"]["sha256"]

    defined = client.post(
        "/types",
        json={
            "name": "sha256_alias",
            "domain": "documents",
            "json_schema": {
                "type": "object",
                "properties": {"sha256": {"type": "string"}, "erased_at": {"type": "string"}},
                "required": ["sha256"],
                "additionalProperties": False,
                "x-identity": ["sha256"],
            },
        },
    )
    assert defined.status_code == 200, defined.text

    attack = client.post(
        "/capture",
        json={
            "type_name": "sha256_alias",
            "attributes": {"sha256": digest, "erased_at": datetime.now(UTC).isoformat()},
        },
    )

    assert attack.status_code == 422, attack.text
    assert "identity field" in attack.json()["detail"]
    after = client.get(f"/entities/{document_id}").json()["entity"]["attributes"]
    assert "erased_at" not in after  # no forged tombstone
    assert after["sha256"] == digest
