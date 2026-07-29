"""e2e: POST /documents and the document-aware forget route (ADR 015, C1)."""

import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pymupdf
import pytest
from fastapi.testclient import TestClient

from api.main import app
from domains.documents.capture import MAX_UPLOAD_BYTES
from domains.documents.storage import BlobStore

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
