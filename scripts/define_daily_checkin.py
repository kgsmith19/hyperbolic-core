"""Define the wellbeing daily_checkin type purely as registry data (invariant 1).

Idempotent operator script (A2.5): runs against whatever DATABASE_URL
kernel.env resolves, skips when the type already exists, prints what it did.
Starts the 14-day capture-sustainability experiment — the schema-driven
Capture form in lifeos-ui renders it with zero UI changes.
"""

from typing import Any

from kernel import db
from kernel.access import AccessContext
from kernel.services import define_type

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
    },
    "required": ["date", "mood", "energy", "stress", "sleep_quality"],
    "additionalProperties": True,
    "x-identity": ["date"],
    "x-pii": ["note", "top_priorities"],
}


def _type_exists(name: str) -> bool:
    with db.connect() as conn:
        return (
            conn.execute("select 1 from type_definition where name = %s", (name,)).fetchone()
            is not None
        )


def define_daily_checkin(ctx: AccessContext | None = None) -> bool:
    """Define daily_checkin if absent. Returns True when it defined the type."""
    ctx = ctx or AccessContext.all()
    if _type_exists("daily_checkin"):
        return False
    define_type(ctx, "daily_checkin", "wellbeing", DAILY_CHECKIN_SCHEMA)
    return True


if __name__ == "__main__":
    if define_daily_checkin():
        print("defined type daily_checkin (domain: wellbeing)")
    else:
        print("daily_checkin already defined - no-op")
