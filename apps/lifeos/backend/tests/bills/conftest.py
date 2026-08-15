"""Bills-tier fixtures: synthetic documents and the scopes extraction runs under.

No real medical document and no real PHI enters this repo: every PDF is built
in-process and every "bill" is invented markers. The Anthropic client is never
constructed either — tests inject a scripted fake, exactly as the chat loop's
tests do (tests/api/test_chat_loop.py).
"""

from collections.abc import Callable
from uuid import UUID

import pytest

from domains.documents.capture import capture_document
from domains.documents.storage import BlobStore
from kernel.access import AccessContext
from tests.conftest import PdfFactory


@pytest.fixture(scope="module")
def store(tmp_path_factory: pytest.TempPathFactory) -> BlobStore:
    """A blob store per test module — never the deploy box's real root."""
    return BlobStore(tmp_path_factory.mktemp("bill-blobs"))


@pytest.fixture(scope="module")
def document_ctx() -> AccessContext:
    return AccessContext.of("documents:read", "documents:write")


@pytest.fixture(scope="module")
def bills_ctx() -> AccessContext:
    """What extraction actually needs: its own domain plus reading documents.
    Deliberately no `documents:write` — extraction must not be able to erase
    the blobs it reads (ADR 015/016)."""
    return AccessContext.of("bills:read", "bills:write", "documents:read")


@pytest.fixture(scope="module")
def make_document(
    document_ctx: AccessContext, store: BlobStore, make_pdf: PdfFactory
) -> Callable[[str], UUID]:
    """Capture one synthetic statement carrying a test-unique marker."""

    def build(marker: str) -> UUID:
        return capture_document(
            document_ctx,
            make_pdf(f"Mercy Clinic statement {marker} amount due 128.40"),
            store=store,
        )

    return build
