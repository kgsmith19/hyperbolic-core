"""Applied-state store for source sync (#572).

Records the last applied source timestamp per (source, external_id). A write
older than what is recorded is refused: a stale source must never overwrite a
newer applied state (the planner's STALE case).
"""

from collections.abc import Mapping
from datetime import datetime

from kernel import db


class StaleWrite(ValueError):
    """The source record is older than the last applied state for its identifier."""


def last_applied(conn: db.Connection, source: str, external_id: str) -> datetime | None:
    row = conn.execute(
        "select applied_at from sync_applied_state where source = %s and external_id = %s",
        (source, external_id),
    ).fetchone()
    return row["applied_at"] if row else None


def applied_map(conn: db.Connection) -> Mapping[tuple[str, str], datetime]:
    rows = conn.execute("select source, external_id, applied_at from sync_applied_state").fetchall()
    return {(row["source"], row["external_id"]): row["applied_at"] for row in rows}


def record_applied(
    conn: db.Connection, source: str, external_id: str, applied_at: datetime
) -> None:
    previous = last_applied(conn, source, external_id)
    if previous is not None and applied_at < previous:
        raise StaleWrite("source is older than the last applied state")
    conn.execute(
        "insert into sync_applied_state (source, external_id, applied_at) values (%s, %s, %s)"
        " on conflict (source, external_id) do update set applied_at = excluded.applied_at",
        (source, external_id, applied_at),
    )
