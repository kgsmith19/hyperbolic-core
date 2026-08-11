"""Text extraction from an uploaded document (ADR 015).

Uploads are hostile until proven otherwise: a PDF is a program-ish container
format parsed by a large C library, so every extraction is bounded (pages and
characters) and every failure is *recorded* rather than raised. A corrupt,
encrypted or adversarial file must make this function return
``extraction_status="failed"`` — never take the process down and never make it
do anything but fail. Nothing here shells out; both parsers run in-process on
bytes already in memory.

`pymupdf` is the primary parser and `pdfplumber` the fallback, per the slice
brief: they are independent implementations (MuPDF vs pdfminer.six), so a file
that trips one often survives the other. The broad ``except`` is deliberate and
is the one place this repo allows it — the requirement is "record the failure".

Nothing derived from the document's *content* leaves this module. The entity
records a status and a parser name and nothing else; the log gets the exception
**class** name only. An exception *message* is built from the tokens the parser
was reading, so it can quote the bill — and the container log is a sink that no
erasure path reaches, neither ``forget()`` (attributes and event payloads) nor
``forget_document`` (blobs). Same rule as ADR 012/014, applied to a worse
payload (invariant 9).
"""

import io
import logging
from dataclasses import dataclass

import pdfplumber
import pymupdf

from domains.documents.types import (
    EXTRACTION_FAILED,
    EXTRACTION_OK,
    EXTRACTION_UNSUPPORTED,
    MIME_PDF,
)

log = logging.getLogger("lifeos.documents")

MAX_TEXT_CHARS = 200_000
MAX_PAGES = 200

METHOD_NONE = "none"
METHOD_PYMUPDF = "pymupdf"
METHOD_PDFPLUMBER = "pdfplumber"


@dataclass(frozen=True)
class Extraction:
    status: str
    method: str
    text: str
    truncated: bool = False


def _bounded(pages: list[str]) -> tuple[str, bool]:
    text = "\n".join(pages).strip()
    if len(text) > MAX_TEXT_CHARS:
        return text[:MAX_TEXT_CHARS], True
    return text, False


def _pymupdf_pages(data: bytes) -> list[str]:
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        if doc.needs_pass:
            raise ValueError("encrypted pdf")
        out = []
        size = 0
        for index in range(min(doc.page_count, MAX_PAGES)):
            page_text: str = doc[index].get_text()
            out.append(page_text)
            size += len(page_text)
            if size > MAX_TEXT_CHARS:
                break
        return out


def _pdfplumber_pages(data: bytes) -> list[str]:
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        out = []
        size = 0
        for page in pdf.pages[:MAX_PAGES]:
            page_text: str = page.extract_text() or ""
            out.append(page_text)
            size += len(page_text)
            if size > MAX_TEXT_CHARS:
                break
        return out


_PARSERS = ((METHOD_PYMUPDF, _pymupdf_pages), (METHOD_PDFPLUMBER, _pdfplumber_pages))


def extract_text(data: bytes, mime: str) -> Extraction:
    """Extract text from ``data``. Never raises: a file we cannot read is a
    recorded fact about the document, not an error for the caller to handle."""
    if mime != MIME_PDF:
        # Images are stored but not read: OCR needs either a shell-out
        # (forbidden here) or a model call (C2's job, not this slice's).
        return Extraction(EXTRACTION_UNSUPPORTED, METHOD_NONE, "")
    for method, parse in _PARSERS:
        try:
            pages = parse(data)
        except Exception as exc:
            # Visible, never silent — but only the *class* name is logged. A
            # parser error message is built from the tokens it was reading, so
            # `%s` on the exception would write fragments of a medical bill
            # into the container log, which neither forget() (attributes and
            # event payloads) nor forget_document() (blobs) can ever reach.
            log.warning("%s could not read the upload: %s", method, type(exc).__name__)
            continue
        text, truncated = _bounded(pages)
        return Extraction(EXTRACTION_OK, method, text, truncated)
    return Extraction(EXTRACTION_FAILED, METHOD_NONE, "")
