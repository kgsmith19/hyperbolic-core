"""The one step every `migrate_*.py` operator script performs.

`define_missing` only ever defines types that are ABSENT, and the registry has
no redefinition path -- deliberately, so application code can never rewrite a
type. An environment that registered a type before its schema tightened
therefore keeps the old, looser schema, and each tightening has shipped a
one-off operator script. All five performed the identical step: compare the
stored schema against what the code now declares, UPDATE it in place, and
append a `type.redefined` audit event naming the reason.

That step lives here once. It stays under `scripts/` rather than in `src/` on
purpose: keeping it out of the installed package is what keeps "the registry
has no redefinition path" true for application code, which is the property
each script's own header was separately restating. The cost is that these
scripts must now be run as `python -m scripts.<name>` from the backend
directory rather than by file path, so that `scripts` resolves as a package --
docs/runbook.md and each script's header say so.
"""

from datetime import datetime
from typing import Any

from psycopg.types.json import Jsonb

from kernel.db import Connection
from kernel.events import append_event


def redefine_types(
    conn: Connection,
    schemas: dict[str, dict[str, Any]],
    reason: str,
    actor: str,
    now: datetime,
) -> int:
    """Point each named type at the schema the code now declares; return how
    many were changed.

    Idempotent in both directions that matter: a type that is absent is
    skipped (`define_missing` will create it from the new schema anyway), and
    one whose stored schema already matches is skipped without writing an
    event, so re-running a migration is a no-op rather than audit noise.
    """
    updated = 0
    for name, schema in schemas.items():
        row = conn.execute(
            "select id, json_schema from type_definition where name = %s", (name,)
        ).fetchone()
        if row is None or row["json_schema"] == schema:
            continue
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
                "reason": reason,
            },
            valid_time=now,
            recorded_at=now,
            actor=actor,
        )
        updated += 1
    return updated
