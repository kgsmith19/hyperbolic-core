"""Integration: the wellbeing daily_checkin type (A2.5) lands as registry data
and round-trips through capture; the define script is idempotent."""

import jsonschema
import pytest

from kernel.access import AccessContext
from kernel.services import capture, forget, get_entity, list_types
from scripts.define_daily_checkin import define_daily_checkin

CHECKIN = {
    "date": "2026-07-28",
    "mood": 4,
    "energy": 3,
    "stress": 2,
    "sleep_quality": 5,
    "top_priorities": ["ship slice 2.5", "evening walk"],
    "note": "solid day",
}


def test_define_then_capture_round_trips(ctx: AccessContext) -> None:
    define_daily_checkin(ctx)
    result = capture(ctx, "daily_checkin", CHECKIN)
    view = get_entity(ctx, result.entity_id)
    assert view.entity.attributes == CHECKIN
    assert "daily_checkin" in view.types


def test_out_of_range_mood_rejected(ctx: AccessContext) -> None:
    define_daily_checkin(ctx)
    with pytest.raises(jsonschema.ValidationError):
        capture(ctx, "daily_checkin", {**CHECKIN, "mood": 6})


def test_forget_erases_flagged_fields(ctx: AccessContext) -> None:
    define_daily_checkin(ctx)
    result = capture(ctx, "daily_checkin", {**CHECKIN, "date": "2026-07-27"})
    forget(ctx, result.entity_id)
    attributes = get_entity(ctx, result.entity_id).entity.attributes
    assert "note" not in attributes
    assert "top_priorities" not in attributes
    assert attributes["mood"] == CHECKIN["mood"]
    assert attributes["energy"] == CHECKIN["energy"]


def test_redefine_is_noop(ctx: AccessContext) -> None:
    define_daily_checkin(ctx)
    assert define_daily_checkin(ctx) is False
    assert [t.name for t in list_types(ctx)].count("daily_checkin") == 1
