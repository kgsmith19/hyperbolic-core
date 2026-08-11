"""Projection maintenance. entity, entity_type, and edge are rebuildable views
of the event log (invariant 2). The live write path and the rebuild script both
go through apply_event, so replay restores state by construction."""

from datetime import datetime
from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb

from kernel.db import Connection

PROJECTION_EVENTS = {"entity.created", "entity.updated", "edge.created", "edge.superseded"}


def _dt(value: str) -> datetime:
    return datetime.fromisoformat(value)


def _dt_opt(value: str | None) -> datetime | None:
    return None if value is None else datetime.fromisoformat(value)


def apply_event(conn: Connection, event_type: str, payload: dict[str, Any]) -> None:
    if event_type in ("entity.created", "entity.updated"):
        ent = payload["entity"]
        conn.execute(
            """
            insert into entity (id, name, attributes, created_at, updated_at)
            values (%s, %s, %s, %s, %s)
            on conflict (id) do update set
                name = excluded.name,
                attributes = excluded.attributes,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at
            """,
            (
                UUID(ent["id"]),
                ent["name"],
                Jsonb(ent["attributes"]),
                _dt(ent["created_at"]),
                _dt(ent["updated_at"]),
            ),
        )
        for type_name in payload["types"]:
            conn.execute(
                """
                insert into entity_type (entity_id, type_id)
                select %s, td.id from type_definition td where td.name = %s
                on conflict do nothing
                """,
                (UUID(ent["id"]), type_name),
            )
    elif event_type == "edge.created":
        edge = payload["edge"]
        conn.execute(
            """
            insert into edge (id, from_entity, relation, to_entity, attributes,
                              valid_from, valid_to, recorded_at, superseded_at)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            on conflict (id) do nothing
            """,
            (
                UUID(edge["id"]),
                UUID(edge["from_entity"]),
                edge["relation"],
                UUID(edge["to_entity"]),
                Jsonb(edge["attributes"]),
                _dt(edge["valid_from"]),
                _dt_opt(edge["valid_to"]),
                _dt(edge["recorded_at"]),
                _dt_opt(edge["superseded_at"]),
            ),
        )
    elif event_type == "edge.superseded":
        edge = payload["edge"]
        conn.execute(
            "update edge set valid_to = %s, superseded_at = %s where id = %s",
            (_dt_opt(edge["valid_to"]), _dt_opt(edge["superseded_at"]), UUID(edge["id"])),
        )


def rebuild(conn: Connection) -> int:
    """Wipe projections and replay the event log in recorded order.

    Runs in the caller's transaction. The event->entity FK is deferrable, so
    entities may be deleted and re-created before commit. embedding rows are
    derived (invariant 6) and wiped with the projections.
    """
    conn.execute("set constraints all deferred")
    conn.execute("delete from embedding")
    conn.execute("delete from edge")
    conn.execute("delete from entity_type")
    conn.execute("delete from entity")
    applied = 0
    rows = conn.execute("select event_type, payload from event order by recorded_at, id").fetchall()
    for row in rows:
        if row["event_type"] in PROJECTION_EVENTS:
            apply_event(conn, row["event_type"], row["payload"])
            applied += 1
    return applied
