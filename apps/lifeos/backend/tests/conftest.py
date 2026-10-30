"""Test fixtures. Tests run against a scratch SQLite file (#512), never a
shared database: each session gets its own, so concurrent runs cannot touch
each other's rows and nothing here can reach real data.
"""

import os
import sys
import tempfile
from collections.abc import Callable, Iterator
from pathlib import Path
from uuid import UUID

import pymupdf
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# Before any kernel import reads it: this session's private database. The
# scratch directory is made once per process (this module can be imported
# twice under different names), and LIFEOS_DB_PATH is always overwritten so a
# developer's real database path can never leak into a test run.
_SCRATCH = Path(
    os.environ.get("LIFEOS_TEST_SCRATCH") or tempfile.mkdtemp(prefix="lifeos-test-")
).resolve()
os.environ["LIFEOS_TEST_SCRATCH"] = str(_SCRATCH)
os.environ["LIFEOS_DB_PATH"] = str(_SCRATCH / "lifeos.db")

from kernel import db  # noqa: E402
from kernel.access import AccessContext  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def clean_database() -> Iterator[None]:
    """A fresh, fully migrated database for the session."""
    assert db.database_path().parent == _SCRATCH, "tests must never open a real database"
    db.migrate()
    yield


PdfFactory = Callable[[str], bytes]


@pytest.fixture(scope="session")
def make_pdf() -> PdfFactory:
    """A one-page PDF containing exactly the given text.

    Lives here because the bills and documents tiers each defined it
    identically. No binary fixture is ever committed and no real medical
    document enters this repo: every PDF is built in-process, so each test's
    bytes -- and therefore its sha256 identity -- are unique to the marker text
    it embeds.
    """

    def build(text: str) -> bytes:
        with pymupdf.open() as doc:
            doc.new_page().insert_text((72, 72), text)
            return bytes(doc.tobytes())

    return build


@pytest.fixture(scope="session")
def ctx() -> AccessContext:
    return AccessContext.all()


@pytest.fixture(scope="session")
def seeded(clean_database: None) -> dict[str, UUID]:
    from scripts.seed import seed

    return seed()
