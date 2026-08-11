"""Integration: the storage_ref anchor migration against a database that still
holds the pre-FIX-1 schema.

The registry refuses redefinition, so the operator script rewrites the type
schema in place; this module recreates the `$`-anchored world with the same raw
UPDATE, runs the script, and puts the shipped schema back whatever happens.
"""

import copy
import re
from collections.abc import Iterator
from typing import Any

import pytest
from psycopg.types.json import Jsonb

from domains.documents.types import DOCUMENT_SCHEMA
from kernel import db
from scripts.migrate_document_ref_anchor import migrate

_REF = DOCUMENT_SCHEMA["properties"]["storage_ref"]["pattern"]
# Exactly what FIX-1 replaced: `$` also matches before a trailing newline.
OLD_DOCUMENT_SCHEMA: dict[str, Any] = copy.deepcopy(DOCUMENT_SCHEMA)
OLD_DOCUMENT_SCHEMA["properties"]["storage_ref"]["pattern"] = _REF.replace("\\Z", "$")


def _stored_schema() -> dict[str, Any] | None:
    with db.connect() as conn:
        row = conn.execute(
            "select json_schema from type_definition where name = 'document'"
        ).fetchone()
    return None if row is None else dict(row["json_schema"])


def _set_schema(schema: dict[str, Any]) -> None:
    with db.connect() as conn:
        conn.execute(
            "update type_definition set json_schema = %s where name = 'document'",
            (Jsonb(schema),),
        )


@pytest.fixture
def legacy(seeded: dict[str, Any]) -> Iterator[None]:
    shipped = _stored_schema()
    if shipped is None:
        pytest.skip("the document type is not defined in this database")
    _set_schema(OLD_DOCUMENT_SCHEMA)
    try:
        yield
    finally:
        _set_schema(shipped)


def test_the_old_stored_pattern_accepts_a_trailing_newline() -> None:
    ref = "ab/" + "0" * 64 + ".bin\n"
    old = OLD_DOCUMENT_SCHEMA["properties"]["storage_ref"]["pattern"]
    assert re.search(old, ref) is not None  # the defect this migration closes
    assert re.search(_REF, ref) is None  # the shipped pattern refuses it


def test_migrate_anchors_the_stored_pattern_and_is_idempotent(legacy: None) -> None:
    assert migrate() == {"types_updated": 1}
    assert _stored_schema() == DOCUMENT_SCHEMA

    assert migrate() == {"types_updated": 0}  # second run is a no-op
