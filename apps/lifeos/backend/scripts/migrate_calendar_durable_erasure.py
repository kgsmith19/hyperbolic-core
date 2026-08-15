"""Migrate an already-ingested database to the durable-erasure calendar schemas.

Slice 7 / ADR 012 "Durable erasure": `attendee`'s identity field moves from
`email` (which is also x-pii, so forget() destroyed it) to `email_hash`, and
`title` stops being required on `appointment`. `define_missing` only ever
defines *absent* types, and the registry refuses redefinition outright
(`type_definition.name` is unique and there is no supersede service), so any
environment that already ran ingestion keeps the old schemas until this runs.

Idempotent operator script, run once per environment BEFORE the new ingestion
code, against whatever DATABASE_URL kernel.env resolves:

    .venv\\Scripts\\python scripts/migrate_calendar_durable_erasure.py

What it does, in one transaction:
1. Rewrites the `attendee` and `appointment` json_schema in place (raw UPDATE:
   the registry has no redefinition path and adding one is a kernel change),
   and appends a `type.redefined` audit event carrying the new schema.
2. Backfills `email_hash` onto every existing attendee that still has an
   `email`, as a real `entity.updated` event plus its projection — the same
   shape `capture` writes — so a projection rebuild reproduces it.

What happens to existing rows: attendees that still hold an `email` keep their
entity id, their edges and their history, and gain `email_hash`; ingestion
finds them exactly as before. Attendees whose email was ALREADY erased before
this migration cannot be re-keyed — the address is gone by design and nothing
in the system can derive its hash. Those rows keep their id, edges and history
but will never match a feed again, so a later feed edit creates a fresh
attendee for that address (the pre-fix defect, one last time, for those
subjects only). The script prints how many are in that state; erase the new
entity once it appears, or accept it. Appointments need no backfill: their
identity field (`ics_key`) was never PII.
"""

from typing import Any

from domains.calendar.types import APPOINTMENT_SCHEMA, ATTENDEE_SCHEMA, email_hash
from kernel import db
from kernel.events import append_event, iso, tx_now
from kernel.projections import apply_event
from kernel.services.common import entity_type_names
from scripts.type_redefinition import redefine_types

ACTOR = "scripts.migrate_calendar_durable_erasure"
_SCHEMAS = {"attendee": ATTENDEE_SCHEMA, "appointment": APPOINTMENT_SCHEMA}
_REASON = "ADR 012 durable erasure: identity fields must survive forget()"


def migrate() -> dict[str, int]:
    counts = {"types_updated": 0, "attendees_backfilled": 0, "attendees_unkeyable": 0}
    with db.connect() as conn:
        now = tx_now(conn)

        counts["types_updated"] = redefine_types(conn, _SCHEMAS, _REASON, ACTOR, now)

        rows = conn.execute(
            """
            select e.id, e.name, e.attributes, e.created_at
            from entity e
            join entity_type et on et.entity_id = e.id
            join type_definition td on td.id = et.type_id
            where td.name = 'attendee'
            order by e.created_at
            """
        ).fetchall()
        for row in rows:
            attributes: dict[str, Any] = row["attributes"]
            if attributes.get("email_hash"):
                continue
            email = attributes.get("email")
            if not isinstance(email, str) or not email:
                counts["attendees_unkeyable"] += 1  # erased before the migration
                continue
            merged = {**attributes, "email_hash": email_hash(email)}
            payload = {
                "entity": {
                    "id": str(row["id"]),
                    "name": merged.get("name") if isinstance(merged.get("name"), str) else None,
                    "attributes": merged,
                    "created_at": iso(row["created_at"]),
                    "updated_at": iso(now),
                },
                "types": entity_type_names(conn, row["id"]),
            }
            append_event(
                conn,
                entity_id=row["id"],
                event_type="entity.updated",
                payload=payload,
                valid_time=now,
                recorded_at=now,
                actor=ACTOR,
            )
            apply_event(conn, "entity.updated", payload)
            counts["attendees_backfilled"] += 1
    return counts


if __name__ == "__main__":
    result = migrate()
    print(
        f"types_updated={result['types_updated']} "
        f"attendees_backfilled={result['attendees_backfilled']} "
        f"attendees_unkeyable={result['attendees_unkeyable']}"
    )
    if result["attendees_unkeyable"]:
        print(
            f"WARNING: {result['attendees_unkeyable']} attendee(s) were erased before this "
            "migration and cannot be re-keyed; a later feed edit will create a fresh "
            "attendee for those addresses. Erase it again when it appears."
        )
