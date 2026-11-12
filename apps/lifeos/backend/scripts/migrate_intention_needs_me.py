"""Migrate an existing database to the Needs Me intention schema (#532, first slice).

The Needs Me slice adds optional `deadline`, `snoozed_until`, `deadline_source`,
`starter`, `prerequisites` and `completion_evidence` to `intention`.
`define_missing` only defines absent types, so an environment that registered
`intention` earlier keeps the old schema, whose `additionalProperties: false`
would refuse every snooze, reschedule and completion write.

Idempotent operator script, run once per environment from the backend directory:

    python -m scripts.migrate_intention_needs_me

No backfill and no data change: every new field is optional, so every existing
record is valid under the old and the new schema alike.
"""

from domains.intentions.types import INTENTION_SCHEMA, TYPE_NAME
from kernel import db
from kernel.events import tx_now
from scripts.type_redefinition import redefine_types

ACTOR = "scripts.migrate_intention_needs_me"
_REASON = "#532: intention gains optional Needs Me fields (deadline, snooze, starter, evidence)"


def migrate() -> dict[str, int]:
    with db.connect() as conn:
        now = tx_now(conn)
        updated = redefine_types(conn, {TYPE_NAME: INTENTION_SCHEMA}, _REASON, ACTOR, now)
        return {"types_updated": updated}


if __name__ == "__main__":
    print(f"types_updated={migrate()['types_updated']}")
