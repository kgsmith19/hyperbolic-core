"""Define (and keep current) the wellbeing daily_checkin type — registry data
only (invariant 1), zero application code.

Idempotent operator script: runs against whatever DATABASE_URL kernel.env
resolves and prints what it did. A2.5 shipped the core one-minute check-in the
schema-driven Capture form in lifeos-ui renders with zero UI changes; INT1
adds the rider fields the recomposed briefing's consumers will read (roadmap
§INT1): 1-tap practice completions, appreciation-expressed,
phone-free-block-kept, caffeine mg + last-cup-time, and no-dairy kept. Every
rider is optional — the check-in stays a one-minute capture.

When the type already exists with an older schema, the script redefines it in
place: raw UPDATE plus a `type.redefined` audit event, the
`migrate_bill_status_verified.py` shape — the registry has no redefinition
path and adding one would be a kernel change.
"""

from typing import Any

from psycopg.types.json import Jsonb

from kernel import db
from kernel.access import AccessContext, require
from kernel.events import append_event, tx_now
from kernel.services import define_type

ACTOR = "scripts.define_daily_checkin"
_REASON = "roadmap INT1: check-in riders — practices, appreciation, phone-free, caffeine, no-dairy"

_SCALE = {"type": "integer", "minimum": 1, "maximum": 5}

DAILY_CHECKIN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "date": {"type": "string"},
        "mood": _SCALE,
        "energy": _SCALE,
        "stress": _SCALE,
        "sleep_quality": _SCALE,
        "top_priorities": {"type": "array", "items": {"type": "string"}},
        "note": {"type": "string"},
        # INT1 riders — all optional, each a tap or one number in the
        # schema-driven capture form. Booleans and numbers follow the
        # mood/energy precedent (values keyed by date, not person-identifying
        # text); `practices_completed` is free text the operator writes and is
        # x-pii like `top_priorities`.
        "practices_completed": {"type": "array", "items": {"type": "string", "maxLength": 200}},
        "appreciation_expressed": {"type": "boolean"},
        "phone_free_block_kept": {"type": "boolean"},
        "caffeine_mg": {"type": "integer", "minimum": 0},
        "last_cup_time": {"type": "string", "maxLength": 32},
        "no_dairy_kept": {"type": "boolean"},
    },
    "required": ["date", "mood", "energy", "stress", "sleep_quality"],
    "additionalProperties": True,
    "x-identity": ["date"],
    "x-pii": ["note", "top_priorities", "practices_completed"],
}


def _existing() -> tuple[Any, Any] | None:
    with db.connect() as conn:
        row = conn.execute(
            "select id, json_schema from type_definition where name = 'daily_checkin'"
        ).fetchone()
    return None if row is None else (row["id"], row["json_schema"])


def define_daily_checkin(ctx: AccessContext | None = None) -> bool:
    """Define daily_checkin if absent, redefine it in place if outdated.
    Returns True when it changed the registry."""
    ctx = ctx or AccessContext.all()
    existing = _existing()
    if existing is None:
        define_type(ctx, "daily_checkin", "wellbeing", DAILY_CHECKIN_SCHEMA)
        return True
    type_id, json_schema = existing
    if json_schema == DAILY_CHECKIN_SCHEMA:
        return False
    require(ctx, "wellbeing:write")
    with db.connect() as conn:
        now = tx_now(conn)
        conn.execute(
            "update type_definition set json_schema = %s where id = %s",
            (Jsonb(DAILY_CHECKIN_SCHEMA), type_id),
        )
        append_event(
            conn,
            entity_id=None,
            event_type="type.redefined",
            payload={
                "type": {
                    "id": str(type_id),
                    "name": "daily_checkin",
                    "json_schema": DAILY_CHECKIN_SCHEMA,
                },
                "reason": _REASON,
            },
            valid_time=now,
            recorded_at=now,
            actor=ACTOR,
        )
    return True


if __name__ == "__main__":
    if define_daily_checkin():
        print("daily_checkin defined or updated (domain: wellbeing)")
    else:
        print("daily_checkin already current - no-op")
