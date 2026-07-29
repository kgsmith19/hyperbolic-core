"""Unit: the blob store's key space and its delete (ADR 015)."""

from hashlib import sha256
from pathlib import Path

import pytest

from domains.documents.storage import KIND_BYTES, KIND_TEXT, BlobStore, blob_root, ref_for

DIGEST = sha256(b"a bill").hexdigest()


def test_put_read_delete_roundtrip(tmp_path: Path) -> None:
    store = BlobStore(tmp_path)
    ref = store.put(DIGEST, KIND_BYTES, b"a bill")
    assert ref == f"{DIGEST[:2]}/{DIGEST}.bin"
    assert store.read(ref) == b"a bill"
    assert store.exists(ref) is True
    assert store.delete(ref) is True
    assert store.exists(ref) is False  # deletion is confirmed, not assumed
    assert store.delete(ref) is False  # already gone, and says so


def test_put_is_idempotent_by_digest(tmp_path: Path) -> None:
    store = BlobStore(tmp_path)
    first = store.put(DIGEST, KIND_TEXT, b"text")
    assert store.put(DIGEST, KIND_TEXT, b"text") == first
    assert len(list(tmp_path.rglob("*.txt"))) == 1
    assert not list(tmp_path.rglob("*.partial"))  # nothing half-written left behind


@pytest.mark.parametrize(
    "ref",
    [
        "../../etc/passwd",
        "/etc/passwd",
        f"{DIGEST[:2]}/../../../{DIGEST}.bin",
        f"{DIGEST[:2]}/{DIGEST}.pdf",
        f"{DIGEST[:2]}/{DIGEST.upper()}.bin",
        "bill.pdf",
    ],
)
def test_refs_outside_the_key_space_are_refused(tmp_path: Path, ref: str) -> None:
    """A ref is read back out of the database; it never becomes a path unless
    it matches the store's own shape."""
    store = BlobStore(tmp_path)
    with pytest.raises(ValueError):
        store.read(ref)
    with pytest.raises(ValueError):
        store.delete(ref)


def test_ref_for_rejects_a_non_digest() -> None:
    with pytest.raises(ValueError, match="sha256"):
        ref_for("not-a-digest", KIND_BYTES)
    with pytest.raises(ValueError, match="kind"):
        ref_for(DIGEST, "exe")


def test_blob_root_is_configurable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LIFEOS_BLOB_ROOT", "/srv/lifeos/blobs")
    assert blob_root() == Path("/srv/lifeos/blobs")
