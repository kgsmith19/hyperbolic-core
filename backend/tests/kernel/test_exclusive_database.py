"""The test session holds the database exclusively.

Every local run points at the one shared lifeos-test database and wipes it on
start, so a second concurrent run must be made to wait rather than allowed to
delete rows out from under this one.
"""

from kernel import db


def test_a_second_session_cannot_take_the_database(exclusive_database: int) -> None:
    with db.connect() as other:
        row = other.execute(
            "select pg_try_advisory_lock(%s) as ok", (exclusive_database,)
        ).fetchone()
        assert row is not None
        if row["ok"]:  # it should not be free — release it rather than leak it
            other.execute("select pg_advisory_unlock(%s)", (exclusive_database,))
        assert row["ok"] is False, "the running session does not hold the database lock"
