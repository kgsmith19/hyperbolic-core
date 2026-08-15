"""Shared synthetic documents (ADR 015 tests).

No binary fixtures are committed and no real medical document ever enters this
repo: every PDF here is built in-process by pymupdf, so each test's bytes — and
therefore its sha256 identity — are unique to the marker text it embeds.
"""

import pytest

from domains.documents.storage import BlobStore


@pytest.fixture(scope="module")
def store(tmp_path_factory: pytest.TempPathFactory) -> BlobStore:
    """A blob store per test module — never the deploy box's real root."""
    return BlobStore(tmp_path_factory.mktemp("blobs"))
