"""Unit: text extraction treats every upload as hostile (ADR 015).

The bar is that nothing here raises. A corrupt or rejecting file must come back
as a recorded ``failed`` extraction, so the document is still captured and the
failure is visible rather than crashing the request.
"""

from collections.abc import Callable

import pymupdf
import pytest

from domains.documents import extract
from domains.documents.extract import MAX_PAGES, extract_text
from domains.documents.types import (
    EXTRACTION_FAILED,
    EXTRACTION_OK,
    EXTRACTION_UNSUPPORTED,
    MIME_PDF,
    MIME_PNG,
)

PdfFactory = Callable[[str], bytes]


def test_pdf_text_is_extracted(make_pdf: PdfFactory) -> None:
    result = extract_text(make_pdf("Amount due 412.50"), MIME_PDF)
    assert result.status == EXTRACTION_OK
    assert result.method == "pymupdf"
    assert "Amount due 412.50" in result.text
    assert result.truncated is False


def test_corrupt_pdf_records_a_failure_instead_of_raising() -> None:
    result = extract_text(b"%PDF-1.7\n" + b"\x00\xff" * 500, MIME_PDF)
    assert result.status == EXTRACTION_FAILED
    assert result.method == "none"
    assert result.text == ""


def test_pdfplumber_takes_over_when_pymupdf_refuses(
    make_pdf: PdfFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = make_pdf("Fallback marker")

    def boom(*args: object, **kwargs: object) -> object:
        raise RuntimeError("mupdf said no")

    monkeypatch.setattr(extract.pymupdf, "open", boom)
    result = extract_text(data, MIME_PDF)
    assert result.status == EXTRACTION_OK
    assert result.method == "pdfplumber"
    assert "Fallback marker" in result.text


def test_images_are_unsupported_not_failed() -> None:
    """C1 stores images but reads none: OCR needs a shell-out (forbidden here)
    or a model call (C2). "unsupported" says that; "failed" would be a lie."""
    result = extract_text(b"\x89PNG\r\n\x1a\nnot really an image", MIME_PNG)
    assert result.status == EXTRACTION_UNSUPPORTED
    assert result.method == "none"
    assert result.text == ""


def test_extracted_text_is_capped(make_pdf: PdfFactory, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(extract, "MAX_TEXT_CHARS", 20)
    result = extract_text(make_pdf("x" * 200), MIME_PDF)
    assert result.status == EXTRACTION_OK
    assert len(result.text) == 20
    assert result.truncated is True


def test_page_cap_bounds_the_work() -> None:
    """A page bomb terminates: only the first MAX_PAGES pages are read."""
    with pymupdf.open() as doc:
        for index in range(MAX_PAGES + 3):
            doc.new_page().insert_text((72, 72), f"page {index} of many")
        data = bytes(doc.tobytes())
    result = extract_text(data, MIME_PDF)
    assert result.status == EXTRACTION_OK
    assert f"page {MAX_PAGES - 1} of many" in result.text
    assert f"page {MAX_PAGES} of many" not in result.text
