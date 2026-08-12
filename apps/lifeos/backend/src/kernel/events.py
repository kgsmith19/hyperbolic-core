"""Append-only event log helpers (invariant 2). Events are the source of truth."""

from datetime import datetime
from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb

from kernel.db import Connection

DEFAULT_ACTOR = "kyle"


def tx_now(conn: Connection) -> datetime:
    """Transaction timestamp: stable within a transaction, so event recorded_at
    and projection timestamps written in the same transaction agree exactly."""
    row = conn.execute("select now() as now").fetchone()
    assert row is not None
    now: datetime = row["now"]
    return now


def iso(dt: datetime) -> str:
    return dt.isoformat()


def append_event(
    conn: Connection,
    *,
    entity_id: UUID | None,
    event_type: str,
    payload: dict[str, Any],
    valid_time: datetime,
    recorded_at: datetime,
    actor: str,
) -> None:
    conn.execute(
        """
        insert into event (entity_id, event_type, payload, valid_time, recorded_at, actor)
        values (%s, %s, %s, %s, %s, %s)
        """,
        (entity_id, event_type, Jsonb(payload), valid_time, recorded_at, actor),
    )
