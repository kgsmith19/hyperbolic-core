"""Seed two deliberately unlike domains purely as registry data (invariant 1).

Proof of extensibility: person (relationships) and workout (health) exist with
zero migrations beyond the kernel's own.
"""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from kernel import db
from kernel.access import AccessContext
from kernel.services import capture, define_type, relate

PERSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "full_name": {"type": "string"},
        "emails": {"type": "array", "items": {"type": "string"}},
        "birthday": {"type": "string"},
    },
    "required": ["full_name", "emails"],
    "additionalProperties": True,
    "x-identity": ["emails"],
    "x-pii": ["full_name", "emails", "birthday"],
}

WORKOUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "kind": {"type": "string"},
        "started_at": {"type": "string"},
        "duration_min": {"type": "number"},
        "avg_hr": {"type": "number"},
    },
    "required": ["kind", "started_at"],
    "additionalProperties": True,
}


def _type_exists(name: str) -> bool:
    with db.connect() as conn:
        return conn.execute(
            "select 1 from type_definition where name = %s", (name,)
        ).fetchone() is not None


def seed(ctx: AccessContext | None = None) -> dict[str, UUID]:
    ctx = ctx or AccessContext.all()
    if not _type_exists("person"):
        define_type(ctx, "person", "relationships", PERSON_SCHEMA)
    if not _type_exists("workout"):
        define_type(ctx, "workout", "health", WORKOUT_SCHEMA)

    kyle = capture(
        ctx,
        "person",
        {"full_name": "Kyle Smith", "emails": ["kylegsmith19@gmail.com"]},
    )
    run = capture(
        ctx,
        "workout",
        {"kind": "run", "started_at": "2026-07-20T07:30:00+00:00",
         "duration_min": 32, "avg_hr": 151},
    )
    lift = capture(
        ctx,
        "workout",
        {"kind": "lift", "started_at": "2026-07-22T18:00:00+00:00", "duration_min": 45},
    )
    relate(ctx, run.entity_id, "performed_by", kyle.entity_id,
           valid_from=datetime(2026, 7, 20, 7, 30, tzinfo=UTC))
    relate(ctx, lift.entity_id, "performed_by", kyle.entity_id,
           valid_from=datetime(2026, 7, 22, 18, 0, tzinfo=UTC))
    return {"person": kyle.entity_id, "run": run.entity_id, "lift": lift.entity_id}


if __name__ == "__main__":
    ids = seed()
    for label, entity_id in ids.items():
        print(f"{label}: {entity_id}")
