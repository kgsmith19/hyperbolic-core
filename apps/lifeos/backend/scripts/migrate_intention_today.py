"""Migrate an existing database to the Today command center's intention schema.

#531 slice 1 added the optional `progress` field and slice 2 the optional
`area` field to `intention`. `define_missing` only defines absent types, so an
environment that registered `intention` earlier keeps the old schema, whose
`additionalProperties: false` refuses every progress change and every area tag.

Idempotent operator script, run once per environment from the backend directory:

    python -m scripts.migrate_intention_today

No backfill and no data change: both fields are optional, so every existing
record is valid under the old and the new schema alike.
"""

from domains.intentions.types import INTENTION_SCHEMA, TYPE_NAME
from kernel import db
from kernel.events import tx_now
from scripts.type_redefinition import redefine_types

ACTOR = "scripts.migrate_intention_today"
_REASON = "#531: intention gains optional `progress` and `area` for the Today view"


def migrate() -> dict[str, int]:
    with db.connect() as conn:
        now = tx_now(conn)
        updated = redefine_types(conn, {TYPE_NAME: INTENTION_SCHEMA}, _REASON, ACTOR, now)
        return {"types_updated": updated}


if __name__ == "__main__":
    print(f"types_updated={migrate()['types_updated']}")
