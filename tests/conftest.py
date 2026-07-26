"""Test fixtures. Tests run against the real Supabase Postgres in .env.

The session starts from a wiped database. Wiping the event log requires
temporarily disabling the append-only trigger — an owner-level maintenance
action available only here; application code can never do this.
"""

import os
import sys
from pathlib import Path
from uuid import UUID

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


@pytest.fixture(scope="session", autouse=True)
def clean_database() -> None:
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


@pytest.fixture(scope="session")
def ctx() -> AccessContext:
    return AccessContext.all()


@pytest.fixture(scope="session")
def seeded(clean_database: None) -> dict[str, UUID]:
    from scripts.seed import seed

    return seed()
