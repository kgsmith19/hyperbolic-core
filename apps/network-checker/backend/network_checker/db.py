"""SQLite schema bootstrap, migration, and per-table CRUD.

Split out of store.py to keep that file inside the project's per-file line
budget (tools/code_simplification.py). store.py re-imports every name below,
so existing callers keep writing `store.open_db(...)`, `store.host_id(...)`,
etc. unchanged -- this module is an implementation detail of store.py, not a
new public surface.
"""
import sqlite3
from pathlib import Path

SCHEMA = Path(__file__).with_name("schema.sql")


def open_db(path):
    # check_same_thread=False: the dashboard serves requests on worker threads
    # while `watch` writes from another process. WAL keeps both safe — one
    # writer, many readers — and sqlite3 serialises access to the connection.
    conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA.read_text())
    _migrate(conn)
    return conn


def _migrate(conn):
    """Upgrade path for existing users: add any column schema.sql has that an
    already-existing on-disk table doesn't.

    `CREATE TABLE IF NOT EXISTS` only creates a table the first time — a
    column added to schema.sql later would otherwise be silently missing
    from every database created before that change, forever. Rather than
    hand-parsing schema.sql's column list, build it fresh in a throwaway
    in-memory connection (where IF NOT EXISTS always creates every table)
    and let SQLite's own column metadata drive the diff.

    Added columns are never NOT NULL, regardless of what schema.sql says:
    SQLite requires a non-NULL default to add a NOT NULL column to a table
    that already has rows, and a migration that could fail on a pre-existing
    database defeats the purpose of having one.
    """
    scratch = sqlite3.connect(":memory:")
    scratch.row_factory = sqlite3.Row
    scratch.executescript(SCHEMA.read_text())
    tables = [r[0] for r in scratch.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")]
    for table in tables:
        have = columns(conn, table)
        if not have:
            continue  # table doesn't exist yet here either; nothing to add
        for col in scratch.execute(f"PRAGMA table_info({table})").fetchall():
            if col["name"] in have:
                continue
            stmt = f"ALTER TABLE {table} ADD COLUMN {col['name']} {col['type'] or 'TEXT'}"
            if col["dflt_value"] is not None:
                stmt += f" DEFAULT {col['dflt_value']}"
            conn.execute(stmt)
    scratch.close()


def columns(conn, table):
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}


def host_id(conn, name, os_name):
    conn.execute(
        "INSERT OR IGNORE INTO hosts (name, os, first_seen)"
        " VALUES (?, ?, datetime('now'))", (name, os_name))
    return conn.execute("SELECT id FROM hosts WHERE name=?", (name,)).fetchone()["id"]


def _insert(conn, table, host, row):
    """Insert one row, ignoring an exact replay. Unknown keys raise."""
    allowed = columns(conn, table)
    unknown = set(row) - allowed
    if unknown:
        raise ValueError(f"unknown {table} column(s): {sorted(unknown)}")

    data = dict(row, host_id=host)
    cols = ", ".join(data)
    marks = ", ".join("?" * len(data))
    conn.execute(f"INSERT OR IGNORE INTO {table} ({cols}) VALUES ({marks})",
                 tuple(data.values()))


def add_sample(conn, host, row, label=None):
    """Insert one sample. `label` tags the row for FR-021's controlled-
    comparison mode (`network-checker experiment --label`); ordinary probe/watch
    runs leave it unset, so they store NULL exactly as before."""
    if label is not None:
        row = dict(row, label=label)
    _insert(conn, "samples", host, row)


def samples_by_label(conn, label, limit=5000):
    return _rows(conn.execute(
        "SELECT * FROM samples WHERE label=? ORDER BY ts DESC LIMIT ?", (label, limit)))


def add_event(conn, host, row):
    _insert(conn, "events", host, row)


def add_error(conn, host, row):
    _insert(conn, "llm_errors", host, row)


def add_scan(conn, host, payload):
    _insert(conn, "env_scans", host, payload)


def _rows(cur):
    return [dict(r) for r in cur]


def samples(conn, limit=5000):
    return _rows(conn.execute(
        "SELECT * FROM samples ORDER BY ts DESC LIMIT ?", (limit,)))


def errors(conn, limit=5000):
    return _rows(conn.execute(
        "SELECT * FROM llm_errors ORDER BY ts DESC LIMIT ?", (limit,)))


def scans(conn, limit=20):
    return _rows(conn.execute(
        "SELECT * FROM env_scans ORDER BY ts DESC LIMIT ?", (limit,)))


def offsets(conn):
    return {r["path"]: r["offset"] for r in conn.execute("SELECT * FROM scan_offsets")}


def save_offsets(conn, new):
    conn.executemany(
        "INSERT INTO scan_offsets (path, offset) VALUES (?, ?)"
        " ON CONFLICT(path) DO UPDATE SET offset=excluded.offset", list(new.items()))


def unsynced(conn, table, limit=500):
    return _rows(conn.execute(
        f"SELECT * FROM {table} WHERE synced=0 ORDER BY id LIMIT ?", (limit,)))


def mark_synced(conn, table, ids):
    conn.executemany(f"UPDATE {table} SET synced=1 WHERE id=?", [(i,) for i in ids])
