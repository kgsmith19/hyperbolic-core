"""Integration: the Today schema migration against a database that still holds
the pre-#531 `intention` schema (no `progress`, no `area`)."""

import copy
from collections.abc import Iterator
from typing import Any

import pytest

from domains.intentions.types import INTENTION_SCHEMA, define_intention_types
from kernel import db
from kernel.access import AccessContext
from kernel.db import Jsonb
from scripts.migrate_intention_today import migrate

OLD_SCHEMA: dict[str, Any] = copy.deepcopy(INTENTION_SCHEMA)
del OLD_SCHEMA["properties"]["progress"]
del OLD_SCHEMA["properties"]["area"]


def _stored() -> dict[str, Any] | None:
    with db.connect() as conn:
        row = conn.execute(
            "select json_schema from type_definition where name = 'intention'"
        ).fetchone()
    return None if row is None else dict(row["json_schema"])


def _set(schema: dict[str, Any]) -> None:
    with db.connect() as conn:
        conn.execute(
            "update type_definition set json_schema = %s where name = 'intention'",
            (Jsonb(schema),),
        )


@pytest.fixture
def legacy(ctx: AccessContext) -> Iterator[None]:
    define_intention_types(ctx)
    shipped = _stored()
    assert shipped is not None
    _set(OLD_SCHEMA)
    try:
        yield
    finally:
        _set(shipped)


def test_the_old_schema_refuses_the_new_fields() -> None:
    assert OLD_SCHEMA["additionalProperties"] is False  # the defect this migration closes
    assert "progress" not in OLD_SCHEMA["properties"]


def test_migrate_installs_the_shipped_schema_and_is_idempotent(legacy: None) -> None:
    assert migrate() == {"types_updated": 1}
    assert _stored() == INTENTION_SCHEMA
    assert migrate() == {"types_updated": 0}
