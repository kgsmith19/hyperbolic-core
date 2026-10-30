"""kernel/db.py on SQLite (#512): the Postgres operators the kernel used, the
search query, the migration ledger and the transaction contract."""

import json
import sqlite3
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

import pytest

from kernel import db


@pytest.mark.parametrize(
    ("container", "contained", "expected"),
    [
        ({"a": 1, "b": {"c": [1, 2]}}, {"b": {"c": [2]}}, True),
        ({"a": 1}, {"a": 1, "b": 2}, False),
        ({"tags": ["x", "y"]}, {"tags": ["y"]}, True),
        ({"tags": ["x"]}, {"tags": "x"}, False),  # a scalar is not an array member here
        (["x", "y"], "x", True),  # top-level array contains a primitive
        ({"n": 1}, {"n": 1.0}, True),
        ({"n": 1}, {"n": "1"}, False),
        ({"flag": True}, {"flag": 1}, False),
    ],
)
def test_json_contains_follows_jsonb_containment(
    container: object, contained: object, expected: bool
) -> None:
    assert db.json_contains(json.dumps(container), json.dumps(contained)) == int(expected)


def test_jsonb_exists_matches_object_keys_and_string_array_members() -> None:
    assert db.jsonb_exists('{"email": 1}', "email") == 1
    assert db.jsonb_exists('["email", "phone"]', "phone") == 1
    assert db.jsonb_exists("[1, 2]", "1") == 0
    assert db.jsonb_exists('{"a": 1}', "b") == 0
    assert db.jsonb_exists(None, "a") == 0


def test_json_remove_keys_drops_only_the_named_keys() -> None:
    out = db.json_remove_keys('{"a": 1, "b": 2, "c": "é"}', '["a", "zz"]')
    assert json.loads(out or "") == {"b": 2, "c": "é"}
    assert "é" in (out or ""), "text stays real unicode, as jsonb stored it"


@pytest.mark.parametrize(
    ("text", "query"),
    [
        ("Lumbar MRI", '"lumbar" "mri"'),
        ("dentist-1@fixture.test", '"dentist 1 fixture test"'),
        ('a "quoted" OR NOT x*', '"a" "quoted" "or" "not" "x"'),
        ("  ", None),
        ("!!!", None),
    ],
)
def test_fts_query_ands_chunks_and_keeps_compound_tokens_as_phrases(
    text: str, query: str | None
) -> None:
    assert db.fts_query(text) == query


def _scratch(tmp_path: Path, files: dict[str, str]) -> Path:
    migrations = tmp_path / "migrations"
    migrations.mkdir()
    for name, sql in files.items():
        (migrations / name).write_text(sql, encoding="utf-8")
    return migrations


def test_migrate_is_idempotent_and_fails_closed_on_drift(tmp_path: Path) -> None:
    migrations = _scratch(tmp_path, {"0001_init.sql": "create table t (id integer primary key);"})
    database = tmp_path / "x.db"
    assert db.migrate(database, migrations) == [1]
    assert db.migrate(database, migrations) == []
    (migrations / "0001_init.sql").write_text(
        "create table t (id integer primary key, v text);", encoding="utf-8"
    )
    with pytest.raises(RuntimeError, match="changed after it was applied"):
        db.migrate(database, migrations)


def test_migrate_refuses_gaps_and_rolls_back_a_failing_file(tmp_path: Path) -> None:
    gap = _scratch(tmp_path, {"0001_a.sql": "select 1;", "0003_c.sql": "select 1;"})
    with pytest.raises(RuntimeError, match="out of sequence"):
        db.migrate(tmp_path / "gap.db", gap)
    other = tmp_path / "other"
    other.mkdir()
    broken = _scratch(
        other,
        {
            "0001_ok.sql": "create table t (id integer);",
            "0002_bad.sql": "insert into t values (1); insert into nowhere values (1);",
        },
    )
    database = other / "b.db"
    with pytest.raises(sqlite3.OperationalError):
        db.migrate(database, broken)
    raw = sqlite3.connect(database)
    assert raw.execute("select count(*) from t").fetchone() == (0,), (
        "the failed file's insert rolled back"
    )
    assert raw.execute("select version from _migrations").fetchall() == [(1,)]


def test_the_transaction_timestamp_is_stable_until_commit(clean_database: None) -> None:
    with db.connect() as conn:
        first = conn.tx_now()
        assert conn.tx_now() is first
        conn.commit()
        assert conn.tx_now() >= first


def test_timestamps_are_stored_as_utc_and_read_back_aware(clean_database: None) -> None:
    local = datetime(2026, 1, 2, 3, 4, 5, 600000, tzinfo=timezone(timedelta(hours=-7)))
    with db.connect() as conn:
        conn.execute("create temp table ts (at timestamptz)")
        conn.execute("insert into ts values (%s)", (local,))
        stored = conn.execute("select cast(at as text) as raw from ts").fetchone()
        back = conn.execute("select at from ts").fetchone()
        conn.rollback()
    assert stored is not None and stored["raw"] == "2026-01-02T10:04:05.600000+00:00"
    assert back is not None and back["at"] == local and back["at"].tzinfo is not None


def test_a_unique_violation_surfaces_as_unique_violation(clean_database: None) -> None:
    with db.connect() as conn:
        conn.execute("create temp table u (k text unique)")
        conn.execute("insert into u values ('a')")
        with pytest.raises(db.UniqueViolation):
            conn.execute("insert into u values ('a')")
        conn.rollback()


def test_a_naive_datetime_is_taken_as_utc() -> None:
    assert db._timestamp(datetime(2026, 1, 1, 12, 0)) == datetime(
        2026, 1, 1, 12, 0, tzinfo=UTC
    ).isoformat(timespec="microseconds")
