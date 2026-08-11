"""Integration: the durable-erasure migration (ADR 012) against a database that
already holds attendees keyed the old way.

The registry refuses redefinition, so the operator script rewrites the type
schema in place; this module recreates the pre-slice-7 world with the same raw
UPDATE, runs the script, and puts the new schema back whatever happens.
"""

from typing import Any
from uuid import UUID

import pytest
from psycopg.types.json import Jsonb

from domains.calendar.types import ATTENDEE_SCHEMA, define_calendar_types, email_hash
from kernel import db
from kernel.access import AccessContext
from kernel.services import capture, find, forget, get_entity, history
from scripts.migrate_calendar_durable_erasure import ACTOR, migrate

# Exactly the shape ADR 012 shipped B1 with: email was both the identity field
# and a PII field, which is the defect this migration exists to undo.
OLD_ATTENDEE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "email": {"type": "string", "maxLength": 255},
        "name": {"type": "string", "maxLength": 255},
    },
    "required": ["email"],
    "additionalProperties": False,
    "x-identity": ["email"],
    "x-pii": ["email", "name"],
}


def _set_attendee_schema(schema: dict[str, Any]) -> None:
    with db.connect() as conn:
        conn.execute(
            "update type_definition set json_schema = %s where name = 'attendee'",
            (Jsonb(schema),),
        )


@pytest.fixture(scope="module")
def legacy(ctx: AccessContext) -> Any:
    """A database keyed the old way, restored to the new schema afterwards."""
    define_calendar_types(ctx)
    _set_attendee_schema(OLD_ATTENDEE_SCHEMA)
    try:
        yield ctx
    finally:
        _set_attendee_schema(ATTENDEE_SCHEMA)


def _attendee(ctx: AccessContext, email: str, name: str) -> UUID:
    return capture(ctx, "attendee", {"email": email, "name": name}).entity_id


def test_migration_backfills_keys_and_reports_unkeyable_rows(legacy: AccessContext) -> None:
    ctx = legacy
    kept = _attendee(ctx, "legacy-kept@fixture.test", "Legacy Kept")
    erased = _attendee(ctx, "legacy-erased@fixture.test", "Legacy Erased")
    forget(ctx, erased)  # erased before the migration: the address is gone for good

    counts = migrate()

    assert counts["types_updated"] == 1
    assert counts["attendees_backfilled"] == 1
    assert counts["attendees_unkeyable"] == 1

    # the kept attendee keeps its identity and gains the non-PII key
    attributes = get_entity(ctx, kept).entity.attributes
    assert attributes["email_hash"] == email_hash("legacy-kept@fixture.test")
    assert attributes["email"] == "legacy-kept@fixture.test"
    assert (
        find(ctx, type_name="attendee", filters={"email_hash": attributes["email_hash"]})[0].id
        == kept
    )
    # written as an event, not just a projection, so a rebuild reproduces it
    backfill = [e for e in history(ctx, kept) if e.actor == ACTOR]
    assert [e.event_type for e in backfill] == ["entity.updated"]
    assert backfill[0].payload["entity"]["attributes"]["email_hash"] == attributes["email_hash"]

    # the pre-erased attendee is left exactly as forget() left it
    erased_attributes = get_entity(ctx, erased).entity.attributes
    assert "email" not in erased_attributes and "email_hash" not in erased_attributes


def test_migration_is_idempotent(legacy: AccessContext) -> None:
    assert migrate() == {
        "types_updated": 0,
        "attendees_backfilled": 0,
        "attendees_unkeyable": 1,  # counted, never re-keyable
    }
