"""Migrate an existing database to the anchored `document.storage_ref` pattern.

Milestone C boundary FIX-1 (`d9d81ac`, ADR 015): `storage_ref` swapped its `$`
anchor for `\\Z`, because `$` also matches *before a trailing newline* — so the
old stored pattern accepts `"ab/<sha256>.bin\\n"`.

`define_missing` only ever defines *absent* types and the registry has no
redefinition path, so every environment that already defined `document` keeps
the `$` schema in `type_definition.json_schema` to this day. The compiled gate
in `domains.documents.capture` was fixed in the same commit and covers every
live write path, which is why this stayed a micro-item rather than an incident
— this script closes the second, stored copy of the same rule. Idempotent
operator script, run once per environment, against whatever DATABASE_URL
kernel.env resolves:

    .venv\\Scripts\\python scripts/migrate_document_ref_anchor.py

It rewrites the `document` json_schema in place (raw UPDATE: the registry has
no redefinition path and adding one would be a kernel change) and appends a
`type.redefined` audit event carrying the new schema — the same shape
`migrate_bill_date_charset.py` uses.

**No backfill, and none is possible to need.** The new pattern is strictly
narrower in exactly one way: it rejects a trailing newline. `blob.put` is the
only writer of `storage_ref` and composes it from a two-hex-character shard, a
hex sha256 and a fixed suffix, so no stored ref can contain a newline and none
can become `invalid` under the tightened schema.
"""

from psycopg.types.json import Jsonb

from domains.documents.types import DOCUMENT_SCHEMA
from kernel import db
from kernel.events import append_event, tx_now

ACTOR = "scripts.migrate_document_ref_anchor"
_NAME = "document"
_REASON = "ADR 015 / FIX-1: storage_ref anchored with \\Z, so a trailing newline is refused"


def migrate() -> dict[str, int]:
    counts = {"types_updated": 0}
    with db.connect() as conn:
        now = tx_now(conn)
        row = conn.execute(
            "select id, json_schema from type_definition where name = %s", (_NAME,)
        ).fetchone()
        if row is None:
            return counts  # never defined here: define_missing will use the new schema
        if row["json_schema"] == DOCUMENT_SCHEMA:
            return counts  # already migrated
        conn.execute(
            "update type_definition set json_schema = %s where id = %s",
            (Jsonb(DOCUMENT_SCHEMA), row["id"]),
        )
        append_event(
            conn,
            entity_id=None,
            event_type="type.redefined",
            payload={
                "type": {"id": str(row["id"]), "name": _NAME, "json_schema": DOCUMENT_SCHEMA},
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
