"""Integration: the wellbeing daily_checkin type (A2.5, riders in INT1) lands
as registry data and round-trips through capture; the define script is
idempotent and redefines an older schema in place."""

from typing import Any

import jsonschema
import pytest
from psycopg.types.json import Jsonb

from kernel import db
from kernel.access import AccessContext
from kernel.services import capture, forget, get_entity, list_types
from scripts.define_daily_checkin import ACTOR, DAILY_CHECKIN_SCHEMA, define_daily_checkin

CHECKIN = {
    "date": "2026-07-28",
    "mood": 4,
    "energy": 3,
    "stress": 2,
    "sleep_quality": 5,
    "top_priorities": ["ship slice 2.5", "evening walk"],
    "note": "solid day",
}

# The INT1 riders, all optional: the check-in stays a one-minute capture.
RIDERS = {
    "practices_completed": ["mobility drill", "evening reading"],
    "appreciation_expressed": True,
    "phone_free_block_kept": True,
    "caffeine_mg": 180,
    "last_cup_time": "13:40",
    "no_dairy_kept": False,
}

# The schema A2.5 shipped (riders absent), which a pre-INT1 database still has.
OLD_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "date": {"type": "string"},
        "mood": {"type": "integer", "minimum": 1, "maximum": 5},
        "energy": {"type": "integer", "minimum": 1, "maximum": 5},
        "stress": {"type": "integer", "minimum": 1, "maximum": 5},
        "sleep_quality": {"type": "integer", "minimum": 1, "maximum": 5},
        "top_priorities": {"type": "array", "items": {"type": "string"}},
        "note": {"type": "string"},
    },
    "required": ["date", "mood", "energy", "stress", "sleep_quality"],
    "additionalProperties": True,
    "x-identity": ["date"],
    "x-pii": ["note", "top_priorities"],
}


def test_define_then_capture_round_trips(ctx: AccessContext) -> None:
    define_daily_checkin(ctx)
    result = capture(ctx, "daily_checkin", CHECKIN)
    view = get_entity(ctx, result.entity_id)
    assert view.entity.attributes == CHECKIN
    assert "daily_checkin" in view.types


def test_rider_fields_round_trip(ctx: AccessContext) -> None:
    define_daily_checkin(ctx)
    result = capture(ctx, "daily_checkin", {**CHECKIN, "date": "2026-07-26", **RIDERS})
    attributes = get_entity(ctx, result.entity_id).entity.attributes
    assert {k: attributes[k] for k in RIDERS} == RIDERS


def test_out_of_range_values_rejected(ctx: AccessContext) -> None:
    define_daily_checkin(ctx)
    with pytest.raises(jsonschema.ValidationError):
        capture(ctx, "daily_checkin", {**CHECKIN, "mood": 6})
    with pytest.raises(jsonschema.ValidationError):
        capture(ctx, "daily_checkin", {**CHECKIN, "caffeine_mg": -1})


def test_forget_erases_flagged_fields(ctx: AccessContext) -> None:
    define_daily_checkin(ctx)
    result = capture(ctx, "daily_checkin", {**CHECKIN, "date": "2026-07-27", **RIDERS})
    forget(ctx, result.entity_id)
    attributes = get_entity(ctx, result.entity_id).entity.attributes
    assert "note" not in attributes
    assert "top_priorities" not in attributes
    assert "practices_completed" not in attributes  # free text the operator wrote
    assert attributes["mood"] == CHECKIN["mood"]
    assert attributes["energy"] == CHECKIN["energy"]
    assert attributes["caffeine_mg"] == RIDERS["caffeine_mg"]  # values, not prose: kept


def test_redefine_is_noop_when_current(ctx: AccessContext) -> None:
    define_daily_checkin(ctx)
    assert define_daily_checkin(ctx) is False
    assert [t.name for t in list_types(ctx)].count("daily_checkin") == 1


def test_redefine_updates_an_older_schema_in_place(ctx: AccessContext) -> None:
    """A pre-INT1 database gains the rider fields from the same define script:
    schema rewritten in place, one `type.redefined` audit event, then a no-op."""
    define_daily_checkin(ctx)
    with db.connect() as conn:
        conn.execute(
            "update type_definition set json_schema = %s where name = 'daily_checkin'",
            (Jsonb(OLD_SCHEMA),),
        )
    try:
        assert define_daily_checkin(ctx) is True
    finally:
        define_daily_checkin(ctx)  # whatever happened, later tests get the current schema
    assert define_daily_checkin(ctx) is False

    with db.connect() as conn:
        row = conn.execute(
            "select json_schema from type_definition where name = 'daily_checkin'"
        ).fetchone()
        assert row is not None
        redefined = conn.execute(
            "select count(*) as n from event where event_type = 'type.redefined' and actor = %s",
            (ACTOR,),
        ).fetchone()
        assert redefined is not None
    assert row["json_schema"] == DAILY_CHECKIN_SCHEMA
    assert int(redefined["n"]) == 1
    assert [t.name for t in list_types(ctx)].count("daily_checkin") == 1
