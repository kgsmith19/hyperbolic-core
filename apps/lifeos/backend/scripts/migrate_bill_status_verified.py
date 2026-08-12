"""Migrate an already-extracting database to the C3 bill/EOB schemas.

Slice 10 / ADR 017: `status` gains its second member (`"verified"`), `bill` and
`eob` gain `verification_receipt_id`, and the schema binds the two together —
`"verified"` is refused unless the record cites the receipt that granted it.
`define_missing` only ever defines *absent* types and the registry has no
redefinition path, so any environment that already ran C2's extraction keeps the
one-member enum and would refuse every promotion the verifier tries to make.

Idempotent operator script, run once per environment BEFORE the new verifier,
against whatever DATABASE_URL kernel.env resolves:

    .venv\\Scripts\\python scripts/migrate_bill_status_verified.py

It rewrites the `bill` and `eob` json_schema in place (raw UPDATE: the registry
has no redefinition path and adding one would be a kernel change) and appends a
`type.redefined` audit event carrying the new schema — the same shape
`migrate_calendar_durable_erasure.py` uses.

No backfill and no data change: every existing record is a `candidate`, which
both the old and the new schema accept, and `verification_receipt` is a brand
new type that `define_missing` will define on the verifier's first run.
"""

from psycopg.types.json import Jsonb

from domains.bills.types import BILL_SCHEMA, EOB_SCHEMA
from kernel import db
from kernel.events import append_event, tx_now

ACTOR = "scripts.migrate_bill_status_verified"
_SCHEMAS = {"bill": BILL_SCHEMA, "eob": EOB_SCHEMA}
_REASON = "ADR 017: status gains 'verified', bound to the verification receipt that granted it"


def migrate() -> dict[str, int]:
    counts = {"types_updated": 0}
    with db.connect() as conn:
        now = tx_now(conn)
        for name, schema in _SCHEMAS.items():
            row = conn.execute(
                "select id, json_schema from type_definition where name = %s", (name,)
            ).fetchone()
            if row is None:
                continue  # never defined here: define_missing will use the new schema
            if row["json_schema"] == schema:
                continue  # already migrated
            conn.execute(
                "update type_definition set json_schema = %s where id = %s",
                (Jsonb(schema), row["id"]),
            )
            append_event(
                conn,
                entity_id=None,
                event_type="type.redefined",
                payload={
                    "type": {"id": str(row["id"]), "name": name, "json_schema": schema},
                    "reason": _REASON,
                },
                valid_time=now,
                recorded_at=now,
                actor=ACTOR,
            )
            counts["types_updated"] += 1
    return counts


if __name__ == "__main__":
    print(f"types_updated={migrate()['types_updated']}")
