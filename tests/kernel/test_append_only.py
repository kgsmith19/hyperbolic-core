"""Acceptance 5: the database itself rejects event mutation (invariant 2)."""

import psycopg
import pytest

from kernel import db


def _one_event_id() -> str:
    with db.connect() as conn:
        row = conn.execute("select id from event limit 1").fetchone()
        assert row is not None, "seed must have produced events"
        return str(row["id"])


def test_update_event_raises(seeded: object) -> None:
    event_id = _one_event_id()
    with pytest.raises(psycopg.errors.RaiseException, match="append-only"):
        with db.connect() as conn:
            conn.execute("update event set actor = 'mallory' where id = %s", (event_id,))


def test_delete_event_raises(seeded: object) -> None:
    event_id = _one_event_id()
    with pytest.raises(psycopg.errors.RaiseException, match="append-only"):
        with db.connect() as conn:
            conn.execute("delete from event where id = %s", (event_id,))
