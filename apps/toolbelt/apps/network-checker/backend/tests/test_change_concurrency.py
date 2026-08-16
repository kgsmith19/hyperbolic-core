"""Finding 16 regression tests: apply()'s atomic 'applying' claim, and the
_LOCKED_STATUSES guards on test()/approve()/change_cli.reject(). Split out
of test_change.py/test_change_approve.py for the same file-length-budget
reason those two are already split from each other."""
import contextlib
import io
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from network_checker import change, change_cli, store
from tests.test_change import _args
from tests.test_change_key import _propose_tested_approved


def _run_two_concurrent_applies(db_path, host, cid, token):
    """Both threads call change.apply() concurrently against two separate
    real connections to one on-disk (WAL) SQLite file -- the same real
    writer-serialization SQLite itself provides, which is the mechanism
    Finding 16's atomic claim actually depends on. Returns (calls,
    results): `calls` records every execute() invocation across both
    threads (the real device write apply() is meant to make at most once);
    `results` maps a thread name to its apply() return code."""
    barrier = threading.Barrier(2)
    calls = []
    calls_lock = threading.Lock()

    def fake_execute(cmd):
        with calls_lock:
            calls.append(cmd)
        return (0, "ok", "")

    results = {}

    def worker(name):
        conn = store.open_db(db_path)
        try:
            barrier.wait(timeout=5)
            results[name] = change.apply(conn, host, _args(action="apply", id=cid, token=token))
        finally:
            conn.close()

    with patch.object(change, "execute", side_effect=fake_execute), \
         patch.object(change, "_verify_with_retry", return_value=(True, [])), \
         contextlib.redirect_stdout(io.StringIO()), \
         contextlib.redirect_stderr(io.StringIO()):
        threads = [threading.Thread(target=worker, args=(n,)) for n in ("t1", "t2")]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)
    return calls, results


class ConcurrentApplyClaimTest(unittest.TestCase):
    """A real two-connection, two-thread race against one on-disk SQLite
    database. Genuine separate OS processes were not exercised -- the
    guarantee under test is SQLite's own writer serialization on the
    shared file, identical whether the two writers are threads or
    processes, so this is a faithful proxy without subprocess-orchestration
    complexity; noted here rather than left silent."""

    def test_two_concurrent_applies_on_the_same_row_only_one_executes(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = str(Path(tmp) / "network_checker.db")
            seed = store.open_db(db_path)
            host = store.host_id(seed, "race-host", "Linux")
            cid, token = _propose_tested_approved(seed)
            seed.close()

            calls, results = _run_two_concurrent_applies(db_path, host, cid, token)

            self.assertEqual(len(calls), 1,
                             "execute() -- the real device write -- must run at "
                             "most once across both concurrent applies")
            self.assertEqual(sorted(results.values()), [0, 3],
                             "exactly one apply succeeds (0); the other loses "
                             "the claim race (3)")
            conn = store.open_db(db_path)
            try:
                self.assertEqual(change._get(conn, cid)["status"], "verified")
            finally:
                conn.close()


class StatusGuardTest(unittest.TestCase):
    """test()/approve()/change_cli.reject() must all refuse to touch a row
    already in change._LOCKED_STATUSES -- before Finding 16 each did an
    unconditional UPDATE regardless of the row's current status."""

    def setUp(self):
        self.conn = store.open_db(":memory:")
        self.addCleanup(self.conn.close)
        self.host = store.host_id(self.conn, "guard-test-host", "Linux")

    def _verified_row(self):
        cid, token = _propose_tested_approved(self.conn)
        with patch.object(change, "execute", return_value=(0, "ok", "")), \
             patch.object(change, "_verify_with_retry", return_value=(True, [])), \
             contextlib.redirect_stdout(io.StringIO()):
            change.apply(self.conn, self.host, _args(action="apply", id=cid, token=token))
        row = change._get(self.conn, cid)
        self.assertEqual(row["status"], "verified")  # precondition for the tests below
        return cid, row

    def test_test_refuses_to_reset_an_already_verified_row(self):
        cid, before = self._verified_row()
        with patch.object(change, "_run_verify", return_value=(False, {})), \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            rc = change.test(self.conn, _args(action="test", id=cid))
        self.assertNotEqual(rc, 0)
        after = change._get(self.conn, cid)
        self.assertEqual(after["status"], "verified")
        self.assertEqual(after["dry_run_output"], before["dry_run_output"])

    def test_approve_refuses_an_already_verified_row(self):
        cid, before = self._verified_row()
        with patch.object(sys.stdin, "isatty", return_value=True), \
             patch("builtins.input", return_value=str(cid)), \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            rc = change.approve(self.conn, _args(action="approve", id=cid))
        self.assertNotEqual(rc, 0)
        after = change._get(self.conn, cid)
        self.assertEqual(after["status"], "verified")
        self.assertEqual(after["approval_token"], before["approval_token"],
                         "no fresh token may be minted for an already-terminal row")

    def test_reject_refuses_an_already_verified_row(self):
        cid, _before = self._verified_row()
        with contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            rc = change_cli.reject(self.conn, _args(action="reject", id=cid))
        self.assertNotEqual(rc, 0)
        self.assertEqual(change._get(self.conn, cid)["status"], "verified")

    def test_reject_still_works_on_a_row_that_is_merely_approved(self):
        """Sanity check that the guard is scoped correctly: reject() must
        remain usable on the states it always could act on."""
        cid, _token = _propose_tested_approved(self.conn)
        with contextlib.redirect_stdout(io.StringIO()):
            rc = change_cli.reject(self.conn, _args(action="reject", id=cid))
        self.assertEqual(rc, 0)
        self.assertEqual(change._get(self.conn, cid)["status"], "rejected")


if __name__ == "__main__":
    unittest.main()
