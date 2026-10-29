"""Acceptance 5: the database itself rejects event mutation (invariant 2)."""

import sqlite3

import pytest

from kernel import db


def _one_event_id() -> str:
    with db.connect() as conn:
        row = conn.execute("select id from event limit 1").fetchone()
        assert row is not None, "seed must have produced events"
        return str(row["id"])


def test_update_event_raises(seeded: object) -> None:
    event_id = _one_event_id()
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        with db.connect() as conn:
            conn.execute("update event set actor = 'mallory' where id = %s", (event_id,))


def test_delete_event_raises(seeded: object) -> None:
    event_id = _one_event_id()
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        with db.connect() as conn:
            conn.execute("delete from event where id = %s", (event_id,))


def test_redaction_mode_still_protects_every_column_but_payload(seeded: object) -> None:
    """The erasure path (invariant 9) widens the trigger only for payload."""
    event_id = _one_event_id()
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        with db.connect() as conn:
            conn.redacting = True
            conn.execute("update event set actor = 'mallory' where id = %s", (event_id,))


def test_redaction_mode_does_not_permit_deletes(seeded: object) -> None:
    event_id = _one_event_id()
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        with db.connect() as conn:
            conn.redacting = True
            conn.execute("delete from event where id = %s", (event_id,))


def test_redaction_mode_permits_a_payload_only_update(seeded: object) -> None:
    """Positive control: the exemption is real, so the refusals above are the
    trigger's column checks and not a trigger that refuses everything."""
    event_id = _one_event_id()
    with db.connect() as conn:
        conn.redacting = True
        conn.execute("update event set payload = payload where id = %s", (event_id,))
        conn.rollback()


def test_a_connection_without_the_redaction_flag_cannot_update_events(seeded: object) -> None:
    """Fail closed: a bare sqlite3 connection (no lifeos_redacting function) is refused."""
    raw = sqlite3.connect(db.database_path())
    try:
        with pytest.raises(sqlite3.OperationalError, match="lifeos_redacting"):
            raw.execute("update event set payload = payload where id = ?", (_one_event_id(),))
    finally:
        raw.close()
