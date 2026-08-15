"""Test fixtures. Tests run against the real Supabase Postgres in .env.

The session starts from a wiped database. Wiping the event log requires
temporarily disabling the append-only trigger — an owner-level maintenance
action available only here; application code can never do this.
"""

import os
import sys
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from uuid import UUID

import pymupdf
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from kernel import db  # noqa: E402
from kernel.access import AccessContext  # noqa: E402
from kernel.env import read_env  # noqa: E402

# The session wipes whatever database it points at, so it must be impossible
# to aim at production. TEST_DATABASE_URL (lifeos-test locally, unset in CI
# where DATABASE_URL is an ephemeral localhost Postgres) wins over
# DATABASE_URL, and the production project ref is refused outright.
_PROD_REF = "vhbzblllaohuljtareza"
_test_url = read_env("TEST_DATABASE_URL")
if _test_url:
    os.environ["DATABASE_URL"] = _test_url
if _PROD_REF in db.database_url():
    raise RuntimeError(
        "refusing to run tests against the production database; set TEST_DATABASE_URL"
    )


# Locally every run points at the ONE shared lifeos-test database, and the
# session below wipes it on start. Two runs at once — two agents, or a stray
# local run beside one — delete each other's rows mid-test, which surfaces as
# unrelated failures and exhausted pooler connections rather than as the
# collision it is. Serialize on a session-level advisory lock: the second run
# waits, then says plainly what holds the database. Free in CI, where
# DATABASE_URL is an ephemeral Postgres nobody else touches.
#
# REQUIRES SESSION-MODE POOLING. An advisory lock lives on the backend session,
# so this holds only while one client connection owns one backend for its whole
# life -- true direct, and true of the Supabase pooler on 5432, which is what
# .env uses. On the transaction pooler (6543) statements are multiplexed across
# backends: the lock would be taken and lost between statements, every run would
# sail past this fixture, and concurrent wipes would corrupt each other again
# with this code still in place looking correct. Do not move the test URL to
# 6543 without replacing this mechanism.
SESSION_LOCK = 0x11FE05
_LOCK_WAIT_SECONDS = 300


@pytest.fixture(scope="session", autouse=True)
def exclusive_database() -> Iterator[int]:
    conn = db.connect()
    conn.autocommit = True  # a session lock outlives transactions; hold no tx
    deadline = time.monotonic() + _LOCK_WAIT_SECONDS
    while True:
        row = conn.execute("select pg_try_advisory_lock(%s) as ok", (SESSION_LOCK,)).fetchone()
        if row is not None and row["ok"]:
            break
        if time.monotonic() >= deadline:
            conn.close()
            raise RuntimeError(
                "another pytest session holds the test database (advisory lock "
                f"{SESSION_LOCK}). It wipes on start, so this run would corrupt it. "
                "Wait for that run to finish, or point TEST_DATABASE_URL at a "
                "database of your own."
            )
        time.sleep(1)
    try:
        yield SESSION_LOCK  # the id, so a test can prove the lock is held
    finally:
        conn.execute("select pg_advisory_unlock(%s)", (SESSION_LOCK,))
        conn.close()


@pytest.fixture(scope="session", autouse=True)
def clean_database(exclusive_database: int) -> None:
    with db.connect() as conn:
        conn.execute("alter table event disable trigger event_append_only_row")
        conn.execute("alter table event disable trigger event_append_only_stmt")
        conn.execute("set constraints all deferred")
        conn.execute("delete from event")
        conn.execute("delete from embedding")
        conn.execute("delete from edge")
        conn.execute("delete from entity_type")
        conn.execute("delete from entity")
        conn.execute("delete from type_definition")
        conn.execute("alter table event enable trigger event_append_only_row")
        conn.execute("alter table event enable trigger event_append_only_stmt")


PdfFactory = Callable[[str], bytes]


@pytest.fixture(scope="session")
def make_pdf() -> PdfFactory:
    """A one-page PDF containing exactly the given text.

    Lives here because the bills and documents tiers each defined it
    identically. No binary fixture is ever committed and no real medical
    document enters this repo: every PDF is built in-process, so each test's
    bytes -- and therefore its sha256 identity -- are unique to the marker text
    it embeds.
    """

    def build(text: str) -> bytes:
        with pymupdf.open() as doc:
            doc.new_page().insert_text((72, 72), text)
            return bytes(doc.tobytes())

    return build


@pytest.fixture(scope="session")
def ctx() -> AccessContext:
    return AccessContext.all()


@pytest.fixture(scope="session")
def seeded(clean_database: None) -> dict[str, UUID]:
    from scripts.seed import seed

    return seed()
