"""Return-code wiring through _run_change()/_rollback()/_persist_apply().

The argv allowlist is tested at the real process seam in test_change_execute;
these state-machine tests inject explicit executor outcomes. Split out of
test_change.py/test_change_approve.py for the same file-length-budget
reason those two are already split from each other."""
import contextlib
import io
import json
import unittest
from unittest.mock import patch

from network_checker import change, store
from tests.test_change import _args
from tests.test_change_key import _propose_tested_approved


class ChangeOutcomeTestCase(unittest.TestCase):
    def setUp(self):
        self.conn = store.open_db(":memory:")
        self.addCleanup(self.conn.close)
        self.host = store.host_id(self.conn, "outcome-test-host", "Linux")


class CommandFailureTest(ChangeOutcomeTestCase):
    def test_nonzero_change_cmd_lands_apply_failed_without_touching_inverse(self):
        cid, token = _propose_tested_approved(
            self.conn, cmd="forward", inverse="inverse")
        with patch.object(change, "execute", return_value=(7, "", "failed")) as spy, \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            rc = change.apply(self.conn, self.host, _args(action="apply", id=cid, token=token))
        self.assertEqual(rc, 4)
        spy.assert_called_once_with("forward")  # the inverse command never ran
        row = change._get(self.conn, cid)
        self.assertEqual(row["status"], "apply_failed")
        self.assertIsNone(row["rolled_back_at"])
        output = json.loads(row["apply_output"])
        self.assertEqual(output["apply"]["returncode"], 7)
        self.assertNotIn("rollback", output)
        items = self.conn.execute(
            "SELECT value FROM config_item WHERE key=?", (f"change.{cid}",)).fetchall()
        self.assertEqual([i["value"] for i in items], ["apply_failed"])

    def test_zero_change_cmd_with_a_passing_probe_still_lands_verified(self):
        """Sanity/contrast: proves the rc branch in _run_change() does not
        also break the true-success path."""
        cid, token = _propose_tested_approved(self.conn, cmd="forward", inverse="inverse")
        with patch.object(change, "execute", return_value=(0, "ok", "")), \
             patch.object(change, "_verify_with_retry", return_value=(True, [])), \
             contextlib.redirect_stdout(io.StringIO()):
            rc = change.apply(self.conn, self.host, _args(action="apply", id=cid, token=token))
        self.assertEqual(rc, 0)
        self.assertEqual(change._get(self.conn, cid)["status"], "verified")


class RollbackFailureTest(ChangeOutcomeTestCase):
    def test_failing_inverse_lands_rollback_failed_not_rolled_back(self):
        cid, token = _propose_tested_approved(self.conn, cmd="forward", inverse="inverse")
        results = [(0, "forward", ""), (9, "", "inverse failed")]
        with patch.object(change, "execute", side_effect=results), \
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
        self.assertEqual(output["rollback"]["returncode"], 9)
        rows = {r["key"]: r["value"] for r in self.conn.execute(
            "SELECT key, value FROM config_item WHERE key LIKE ?", (f"change.{cid}.%",))}
        self.assertEqual(rows, {f"change.{cid}.apply": "verify_failed",
                                f"change.{cid}.rollback": "rollback_failed"})

    def test_succeeding_inverse_with_a_failing_post_verify_also_fails(self):
        """rrc==0 alone is not enough -- the post-restore probe result
        still has to pass, or the row is not actually restored."""
        cid, token = _propose_tested_approved(self.conn, cmd="forward", inverse="inverse")
        with patch.object(change, "execute", return_value=(0, "", "")), \
             patch.object(change, "_verify_with_retry", return_value=(False, [])), \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            rc = change.apply(self.conn, self.host, _args(action="apply", id=cid, token=token))
        self.assertEqual(rc, 5)
        self.assertEqual(change._get(self.conn, cid)["status"], "rollback_failed")


if __name__ == "__main__":
    unittest.main()
