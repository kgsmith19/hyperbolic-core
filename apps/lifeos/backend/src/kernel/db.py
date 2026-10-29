"""Local SQLite database (#512). LIFEOS_DB_PATH from env, else var/lifeos/lifeos.db.

The kernel's call sites keep psycopg's contract: `%s` placeholders, `Jsonb`
for JSON parameters, UUID and datetime values in and out, dict rows, and
`with db.connect() as conn:` committing on success and rolling back on error.
Postgres operators the kernel used are registered as SQL functions on every
connection: json_contains (jsonb @>), jsonb_exists (jsonb ?) and
json_remove_keys (jsonb - text[]).
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from collections.abc import Iterable, Iterator, Sequence
from datetime import UTC, datetime
from pathlib import Path
from types import TracebackType
from typing import Any
from uuid import UUID

from kernel.env import read_env

BACKEND_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = BACKEND_ROOT / "db" / "migrations"
DEFAULT_DB_PATH = BACKEND_ROOT.parents[2] / "var" / "lifeos" / "lifeos.db"
_MIGRATION_FILE = re.compile(r"^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$")


class Jsonb:
    """A JSON parameter, as psycopg's Jsonb wrapper was."""

    __slots__ = ("obj",)

    def __init__(self, obj: Any) -> None:
        self.obj = obj


class UniqueViolation(sqlite3.IntegrityError):
    """A unique constraint failed (psycopg.errors.UniqueViolation's role)."""


def _timestamp(value: datetime) -> str:
    # Naive datetimes are taken as UTC; everything is stored as UTC so text
    # order is time order.
    aware = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return aware.astimezone(UTC).isoformat(timespec="microseconds")


sqlite3.register_adapter(UUID, str)
sqlite3.register_adapter(datetime, _timestamp)
sqlite3.register_adapter(Jsonb, lambda value: json.dumps(value.obj, ensure_ascii=False))
sqlite3.register_converter("uuid", lambda raw: UUID(raw.decode()))
sqlite3.register_converter("timestamptz", lambda raw: datetime.fromisoformat(raw.decode()))
sqlite3.register_converter("jsonb", lambda raw: json.loads(raw))
sqlite3.register_converter("boolean", lambda raw: raw not in (b"0", b""))


def _same_scalar(a: Any, b: Any) -> bool:
    """jsonb scalar equality: numbers compare by value (1 = 1.0), never with booleans."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, int | float) and isinstance(b, int | float):
        return a == b
    return type(a) is type(b) and a == b


def _contains(container: Any, contained: Any, top: bool = True) -> bool:
    """Postgres jsonb @> semantics."""
    if isinstance(contained, dict):
        return isinstance(container, dict) and all(
            key in container and _contains(container[key], value, top=False)
            for key, value in contained.items()
        )
    if isinstance(contained, list):
        if not isinstance(container, list):
            return False
        return all(
            any(_contains(item, wanted, top=False) for item in container) for wanted in contained
        )
    if isinstance(container, list):
        # Only a top-level array contains a bare primitive (jsonb's one exception).
        return top and any(_same_scalar(item, contained) for item in container)
    return _same_scalar(container, contained)


def _load(value: str | bytes | None) -> Any:
    return None if value is None else json.loads(value)


def json_contains(container: str | None, contained: str | None) -> int:
    if container is None or contained is None:
        return 0
    return int(_contains(_load(container), _load(contained)))


def jsonb_exists(document: str | None, key: str | None) -> int:
    """Postgres jsonb ? : an object key, or a string element of an array."""
    if document is None or key is None:
        return 0
    value = _load(document)
    if isinstance(value, dict):
        return int(key in value)
    if isinstance(value, list):
        return int(any(item == key for item in value if isinstance(item, str)))
    return int(value == key)


def json_remove_keys(document: str | None, keys: str | None) -> str | None:
    """Postgres jsonb - text[] on an object."""
    if document is None:
        return None
    value = _load(document)
    drop = set(_load(keys) or [])
    if isinstance(value, dict):
        value = {k: v for k, v in value.items() if k not in drop}
    return json.dumps(value, ensure_ascii=False)


def json_get(document: str | None, key: str | None) -> str | None:
    """Postgres jsonb -> text: the member as JSON text, or NULL."""
    if document is None or key is None:
        return None
    value = _load(document)
    if isinstance(value, dict) and key in value:
        return json.dumps(value[key], ensure_ascii=False)
    return None


def fts_query(text: str) -> str | None:
    """plainto_tsquery('simple', text) as an FTS5 query, or None for no words.

    Whitespace-separated chunks are ANDed, as plainto_tsquery ANDs words. A
    chunk FTS5 would split (an email, a host, a hyphenated word) must match as
    a phrase -- its parts adjacent and in order -- because Postgres' parser
    kept such a chunk as one token. Every word is quoted, so no input is read
    as FTS5 syntax.
    """
    phrases = []
    for chunk in text.lower().split():
        words = re.findall(r"\w+", chunk)
        if words:
            phrases.append('"' + " ".join(words) + '"')
    return " ".join(phrases) or None


def _placeholders(sql: str) -> str:
    return re.sub(r"%(s|%)", lambda m: "?" if m.group(1) == "s" else "%", sql)


def _params(params: Sequence[Any] | None) -> list[Any]:
    out: list[Any] = []
    for value in params or ():
        # A list parameter (psycopg sent text[] / any(%s)) travels as JSON.
        out.append(
            json.dumps(value, ensure_ascii=False) if isinstance(value, list | tuple) else value
        )
    return out


class Cursor:
    def __init__(self, raw: sqlite3.Cursor) -> None:
        self._raw = raw

    def fetchone(self) -> dict[str, Any] | None:
        row = self._raw.fetchone()
        return None if row is None else self._dict(row)

    def fetchall(self) -> list[dict[str, Any]]:
        return [self._dict(row) for row in self._raw.fetchall()]

    def __iter__(self) -> Iterator[dict[str, Any]]:
        for row in self._raw:
            yield self._dict(row)

    @property
    def rowcount(self) -> int:
        return self._raw.rowcount

    def _dict(self, row: Sequence[Any]) -> dict[str, Any]:
        return {column[0]: value for column, value in zip(self._raw.description, row, strict=True)}


class Connection:
    """One SQLite connection with psycopg-shaped transactions."""

    def __init__(self, raw: sqlite3.Connection) -> None:
        self._raw = raw
        self._now: datetime | None = None
        self.redacting = False
        raw.create_function("lifeos_redacting", 0, lambda: int(self.redacting), deterministic=False)
        raw.create_function("json_contains", 2, json_contains, deterministic=True)
        raw.create_function("jsonb_exists", 2, jsonb_exists, deterministic=True)
        raw.create_function("json_remove_keys", 2, json_remove_keys, deterministic=True)
        raw.create_function("json_get", 2, json_get, deterministic=True)

    def execute(self, sql: str, params: Sequence[Any] | None = None) -> Cursor:
        if not self._raw.in_transaction:
            self._raw.execute("begin")
        try:
            return Cursor(self._raw.execute(_placeholders(sql), _params(params)))
        except sqlite3.IntegrityError as exc:
            if str(exc).startswith("UNIQUE constraint failed"):
                raise UniqueViolation(str(exc)) from exc
            raise

    def executescript(self, sql: str) -> None:
        self._raw.executescript(sql)

    def tx_now(self) -> datetime:
        """Transaction timestamp: stable within a transaction (Postgres now())."""
        if self._now is None:
            self._now = datetime.now(UTC)
        return self._now

    def defer_constraints(self) -> None:
        """Foreign keys are checked at commit for the rest of this transaction."""
        self.execute("pragma defer_foreign_keys = on")

    def commit(self) -> None:
        self._raw.commit()
        self._now = None
        self.redacting = False

    def rollback(self) -> None:
        self._raw.rollback()
        self._now = None
        self.redacting = False

    def close(self) -> None:
        self._raw.close()

    def __enter__(self) -> Connection:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        try:
            if exc_type is None:
                self.commit()
            else:
                self.rollback()
        finally:
            self.close()


def database_path() -> Path:
    configured = read_env("LIFEOS_DB_PATH")
    return Path(configured).expanduser().resolve() if configured else DEFAULT_DB_PATH


def _open(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = sqlite3.connect(
        path, detect_types=sqlite3.PARSE_DECLTYPES | sqlite3.PARSE_COLNAMES, isolation_level=None
    )
    raw.execute("pragma journal_mode = wal")
    raw.execute("pragma foreign_keys = on")
    raw.execute("pragma busy_timeout = 5000")
    return raw


def read_migrations(directory: Path = MIGRATIONS_DIR) -> list[tuple[int, str, str, str]]:
    """(version, name, sql, sha256) for each NNNN_<name>.sql, contiguous from 0001."""
    out = []
    for index, path in enumerate(sorted(directory.glob("*.sql")), start=1):
        match = _MIGRATION_FILE.match(path.name)
        if match is None:
            raise RuntimeError(f"migration {path.name} must be named NNNN_<name>.sql")
        if int(match.group(1)) != index:
            raise RuntimeError(f"migration {path.name} is out of sequence: expected {index:04d}")
        sql = path.read_text(encoding="utf-8")
        out.append((index, match.group(2), sql, hashlib.sha256(sql.encode()).hexdigest()))
    return out


def migrate(path: Path | None = None, directory: Path = MIGRATIONS_DIR) -> list[int]:
    """Apply pending migrations, each in one transaction; fail closed on drift."""
    raw = _open(path or database_path())
    try:
        raw.execute(
            "create table if not exists _migrations ("
            "version integer primary key, name text not null, sha256 text not null, "
            "applied_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
            ") strict"
        )
        migrations = read_migrations(directory)
        applied = raw.execute(
            "select version, name, sha256 from _migrations order by version"
        ).fetchall()
        for version, name, sha in applied:
            if version > len(migrations):
                raise RuntimeError(
                    f"migration {version} ({name}) was applied but its file is missing"
                )
            if migrations[version - 1][3] != sha:
                raise RuntimeError(f"migration {version} ({name}) changed after it was applied")
        done = []
        for version, name, sql, sha in migrations[len(applied) :]:
            raw.execute("begin immediate")
            try:
                # executescript would commit the open transaction first; run the
                # statements one by one inside it instead.
                for statement in _statements(sql):
                    raw.execute(statement)
                raw.execute(
                    "insert into _migrations (version, name, sha256) values (?, ?, ?)",
                    (version, name, sha),
                )
                raw.execute("commit")
            except Exception:
                raw.execute("rollback")
                raise
            done.append(version)
        return done
    finally:
        raw.close()


def _statements(sql: str) -> Iterable[str]:
    """Split a migration into complete statements: cut at each ';' that ends
    one (so trigger bodies and quoted ';' stay whole), even mid-line."""
    start = 0
    for index, char in enumerate(sql):
        if char == ";" and sqlite3.complete_statement(sql[start : index + 1]):
            statement = sql[start : index + 1]
            if statement.strip():
                yield statement
            start = index + 1
    rest = sql[start:]
    if any(line.strip() and not line.strip().startswith("--") for line in rest.splitlines()):
        raise RuntimeError("migration ends with an incomplete statement")


_migrated: set[Path] = set()


def connect() -> Connection:
    path = database_path()
    if path not in _migrated:
        migrate(path)
        _migrated.add(path)
    return Connection(_open(path))
