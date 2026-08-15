"""Shared read-only counters over the event log and entity projection.

These three were defined 21 times across the suite -- `event_count` alone 16
times, in two variants that differed only in whether they imported `db` at
module or function scope. They ask the same question every time, so they ask
it in one place.
"""

from kernel import db


def event_count() -> int:
    """Rows in the append-only event log."""
    with db.connect() as conn:
        row = conn.execute("select count(*) as n from event").fetchone()
        assert row is not None
        return int(row["n"])


def entity_count() -> int:
    """Rows in the entity projection."""
    with db.connect() as conn:
        row = conn.execute("select count(*) as n from entity").fetchone()
        assert row is not None
        return int(row["n"])


def events_mentioning(needle: str) -> int:
    """Events whose payload still contains `needle` anywhere -- the erasure
    bar: after an erasure this must reach 0 for the erased value, which is a
    claim about the event log itself, not about any projection built from it."""
    with db.connect() as conn:
        row = conn.execute(
            "select count(*) as n from event where payload::text like %s", (f"%{needle}%",)
        ).fetchone()
        assert row is not None
        return int(row["n"])
