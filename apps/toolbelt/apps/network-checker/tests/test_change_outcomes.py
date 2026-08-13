"""Finding 17 regression tests: real rc/rrc wiring through _run_change()/
_rollback()/_persist_apply(). change.execute() itself is NOT mocked here --
only _verify_with_retry (no real network probe available in this sandbox).
`true`/`false` are real, hermetic subprocess calls, proving the wiring
end-to-end rather than just the branch logic in isolation. Split out of
test_change.py/test_change_approve.py for the same file-length-budget
reason those two are already split from each other."""
import contextlib
import io
import json
import unittest
from unittest.mock import patch

from netcheck import change, store
from tests.test_change import _args
from tests.test_change_key import _propose_tested_approved


class ChangeOutcomeTestCase(unittest.TestCase):
    def setUp(self):
        self.conn = store.open_db(":memory:")
        self.addCleanup(self.conn.close)
        self.host = store.host_id(self.conn, "outcome-test-host", "Linux")


class CommandFailureTest(ChangeOutcomeTestCase):
    def test_a_real_nonzero_change_cmd_lands_apply_failed_without_touching_inverse(self):
        cid, token = _propose_tested_approved(
            self.conn, cmd="false", inverse="echo should-never-run")
        with patch.object(change, "execute", wraps=change.execute) as spy, \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            rc = change.apply(self.conn, self.host, _args(action="apply", id=cid, token=token))
        self.assertEqual(rc, 4)
        spy.assert_called_once_with("false")  # the inverse command never ran
        row = change._get(self.conn, cid)
        self.assertEqual(row["status"], "apply_failed")
        self.assertIsNone(row["rolled_back_at"])
        output = json.loads(row["apply_output"])
        self.assertEqual(output["apply"]["returncode"], 1)
        self.assertNotIn("rollback", output)
        items = self.conn.execute(
            "SELECT value FROM config_item WHERE key=?", (f"change.{cid}",)).fetchall()
        self.assertEqual([i["value"] for i in items], ["apply_failed"])

    def test_a_real_zero_change_cmd_with_a_passing_probe_still_lands_verified(self):
        """Sanity/contrast: proves the rc branch in _run_change() does not
        also break the true-success path."""
        cid, token = _propose_tested_approved(self.conn, cmd="true", inverse="true")
        with patch.object(change, "execute", wraps=change.execute), \
             patch.object(change, "_verify_with_retry", return_value=(True, [])), \
             contextlib.redirect_stdout(io.StringIO()):
            rc = change.apply(self.conn, self.host, _args(action="apply", id=cid, token=token))
        self.assertEqual(rc, 0)
        self.assertEqual(change._get(self.conn, cid)["status"], "verified")


class RollbackFailureTest(ChangeOutcomeTestCase):
    def test_a_real_failing_inverse_lands_rollback_failed_not_rolled_back(self):
        cid, token = _propose_tested_approved(self.conn, cmd="true", inverse="false")
        with patch.object(change, "execute", wraps=change.execute), \
             patch.object(change, "_verify_with_retry", return_value=(False, [])), \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            rc = change.apply(self.conn, self.host, _args(action="apply", id=cid, token=token))
        self.assertEqual(rc, 5)
        row = change._get(self.conn, cid)
        self.assertEqual(row["status"], "rollback_failed")
        self.assertIsNone(row["rolled_back_at"],
                          "must not claim a restore time for a rollback that failed")
        output = json.loads(row["apply_output"])
        self.assertEqual(output["rollback"]["returncode"], 1)
        items = self.conn.execute(
            "SELECT value FROM config_item WHERE key=?", (f"change.{cid}",)).fetchall()
        self.assertEqual([i["value"] for i in items], ["rollback_failed"])

    def test_a_real_succeeding_inverse_with_a_failing_post_verify_also_fails(self):
        """rrc==0 alone is not enough -- the post-restore probe result
        still has to pass, or the row is not actually restored."""
        cid, token = _propose_tested_approved(self.conn, cmd="true", inverse="true")
        with patch.object(change, "execute", wraps=change.execute), \
             patch.object(change, "_verify_with_retry", return_value=(False, [])), \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            rc = change.apply(self.conn, self.host, _args(action="apply", id=cid, token=token))
        self.assertEqual(rc, 5)
        self.assertEqual(change._get(self.conn, cid)["status"], "rollback_failed")


if __name__ == "__main__":
    unittest.main()
