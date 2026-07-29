"""The blob store: where a document's bytes and extracted text actually live
(ADR 015).

A content-addressed directory tree on the deploy box's filesystem, rooted at
``LIFEOS_BLOB_ROOT`` (default ``var/blobs`` beside the process). Nothing here
touches the database and nothing in the database holds file content — the
entity holds a ref, the store holds the bytes, and ``delete`` is the half of
``forget()`` that the kernel cannot do (invariant 9).

Why the filesystem and not `entity.attributes`: attributes are indexed into a
generated tsvector and erased strictly per entity, so a bill's text stored
there would be full-text searchable forever (ADR 012/013/014). Why the
filesystem and not Supabase Storage: erasure would become a network call to a
service whose delete we cannot verify in CI, and it would need a new
service-role credential — a local unlink is auditable, testable and needs no
secret (ADR 015).

Keys are ``<first two hex>/<sha256>.<bin|txt>`` and nothing else: the original
filename never becomes a path (it is untrusted, PII-bearing text), and the
suffix is deliberately not the real extension so nothing on the box is tempted
to open a stored file by type.
"""

import os
import re
from pathlib import Path

from kernel.env import read_env

KIND_BYTES = "bin"
KIND_TEXT = "txt"

REF_PATTERN = re.compile(r"^[0-9a-f]{2}/[0-9a-f]{64}\.(bin|txt)$")
DEFAULT_ROOT = "var/blobs"


def blob_root() -> Path:
    """Where blobs live. ``LIFEOS_BLOB_ROOT`` overrides; the default is
    relative to the process working directory (``/app/var/blobs`` in the
    container, which compose mounts as a volume)."""
    return Path(read_env("LIFEOS_BLOB_ROOT") or DEFAULT_ROOT).expanduser()


def ref_for(digest: str, kind: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("blob digest must be a lowercase hex sha256")
    if kind not in (KIND_BYTES, KIND_TEXT):
        raise ValueError(f"unknown blob kind: {kind!r}")
    return f"{digest[:2]}/{digest}.{kind}"


class BlobStore:
    """Content-addressed file storage. Writes are idempotent by digest."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = (root or blob_root()).resolve()

    def _path(self, ref: str) -> Path:
        # Refs come back out of the database, which is the same trust level as
        # whatever wrote them; validate the shape and re-check containment
        # rather than trusting either.
        if not REF_PATTERN.match(ref):
            raise ValueError(f"malformed blob ref: {ref!r}")
        path = (self.root / ref).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError(f"blob ref escapes the store root: {ref!r}")
        return path

    def put(self, digest: str, kind: str, data: bytes) -> str:
        """Store ``data`` under its digest and return the ref. Already-stored
        content is left alone — the same bytes are the same blob."""
        ref = ref_for(digest, kind)
        path = self._path(ref)
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            staged = path.with_name(path.name + ".partial")
            staged.write_bytes(data)
            os.chmod(staged, 0o600)  # medical documents: owner-only on the box
            staged.replace(path)  # atomic: a crash leaves no half-written blob
        return ref

    def read(self, ref: str) -> bytes:
        return self._path(ref).read_bytes()

    def exists(self, ref: str) -> bool:
        return self._path(ref).is_file()

    def delete(self, ref: str) -> bool:
        """Remove one blob, and confirm it is gone.

        Returns whether a file was actually there — the caller decides whether
        a ``False`` means "already clean" or "this erasure deleted nothing and
        must not be reported as a success". The post-unlink check is what makes
        deletion *verified* rather than merely attempted.
        """
        path = self._path(ref)
        if not path.is_file():
            return False
        path.unlink()
        if path.exists():
            raise OSError(f"blob still present after unlink: {ref}")
        return True
