"""Hermetic tests for the change lifecycle engine (netcheck/change.py; NC-4;
05-f section 4). Real in-memory SQLite, patch.object at every real seam,
exactly tests/test_watch.py's convention -- no real subprocess/network call
here. The one deliberately real subprocess test (TTY refusal, NC-4.2) lives
in tests/test_change_approve.py, split out for the file-budget reason
watch.py was split from __main__.py."""
import argparse
import contextlib
import io
import json
import unittest
from unittest.mock import patch

from netcheck import change, store


def _args(action="propose", **overrides):
    base = {"action": action, "title": "t", "cause": None, "cmd": "true",
            "inverse": "true", "verify": "dns_public:ok", "device": None}
    base.update(overrides)
    return argparse.Namespace(**base)


class ChangeTestCase(unittest.TestCase):
    def setUp(self):
        self.conn = store.open_db(":memory:")
        self.addCleanup(self.conn.close)
        self.host = store.host_id(self.conn, "change-test-host", "Linux")

    def propose(self, **overrides):
        with contextlib.redirect_stdout(io.StringIO()):
            change.propose(self.conn, _args(**overrides))
        return self.conn.execute(
            "SELECT id FROM change_request ORDER BY id DESC LIMIT 1").fetchone()["id"]


class ProposeInvariantsTest(ChangeTestCase):
    """05-f 4.1's DDL invariants: change_cmd/inverse_cmd/verify_probe are
    NOT NULL at creation; a fresh row starts life 'proposed'."""

    def test_propose_records_every_field_and_starts_proposed(self):
        cid = self.propose(title="Fix DNS", cause="router_dns", cmd="tools/fix_dns.sh",
                           inverse="restore", verify="dns_public:ok")
        row = change._get(self.conn, cid)
        self.assertEqual(row["status"], "proposed")
        self.assertEqual(row["title"], "Fix DNS")
        self.assertEqual(row["change_cmd"], "tools/fix_dns.sh")
        self.assertIsNone(row["dry_run_output"])
        self.assertIsNone(row["approval_token"])


class ApplyWithoutDryRunOrTokenTest(ChangeTestCase):
    """NC-4.1: apply without a valid token exits non-zero and makes no
    device write -- proven via the fake executor, not just the exit code."""

    def test_apply_on_a_bare_proposal_is_rejected_before_any_execute_call(self):
        cid = self.propose()
        with patch.object(change, "execute") as executor, \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            rc = change.apply(self.conn, self.host, _args(action="apply", id=cid, token="bogus"))
        self.assertNotEqual(rc, 0)
        executor.assert_not_called()
        row = change._get(self.conn, cid)
        self.assertIsNone(row["applied_at"])

    def test_apply_after_test_but_before_approve_is_still_rejected(self):
        """Invariant 2: `tested` is not enough -- only `approved` + a real token works."""
        cid = self.propose()
        with patch.object(change, "_run_verify", return_value=(False, {})), \
             contextlib.redirect_stdout(io.StringIO()):
            change.test(self.conn, _args(action="test", id=cid))
        with patch.object(change, "execute") as executor, \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            rc = change.apply(self.conn, self.host, _args(action="apply", id=cid, token="x"))
        self.assertNotEqual(rc, 0)
        executor.assert_not_called()

    def test_a_correctly_computed_token_still_cannot_apply_an_unapproved_row(self):
        """The other two tests here use a bogus token, so they can't tell
        "wrong token" from "status != approved". _token()'s formula is
        public/deterministic, so this uses the REAL token for the row's
        own (unapproved) state to isolate the status check specifically."""
        cid = self.propose()
        with patch.object(change, "_run_verify", return_value=(False, {})), \
             contextlib.redirect_stdout(io.StringIO()):
            change.test(self.conn, _args(action="test", id=cid))
        row = change._get(self.conn, cid)
        real_token = change._token(row, row["approved_at"], row["approved_by"])
        with patch.object(change, "execute") as executor, \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            rc = change.apply(self.conn, self.host, _args(action="apply", id=cid, token=real_token))
        self.assertNotEqual(rc, 0)
        executor.assert_not_called()


class TokenBindingTest(ChangeTestCase):
    """NC-4.3: approve a change, mutate change_cmd/inverse_cmd directly in
    the row, then apply with the token issued at approve time. Must reject --
    adversarial, not a happy-path proof."""

    def _approve(self, cid):
        with patch.object(change, "_run_verify", return_value=(True, {})), \
             contextlib.redirect_stdout(io.StringIO()):
            change.test(self.conn, _args(action="test", id=cid))
        row = change._get(self.conn, cid)
        approved_at = change._now()
        token = change._token(row, approved_at, "tester")
        self.conn.execute(
            "UPDATE change_request SET approved_at=?, approved_by=?, approval_token=?, status='approved' WHERE id=?",
            (approved_at, "tester", token, cid))
        return token

    def test_unmodified_token_applies_cleanly(self):
        """Happy path first, so the adversarial case below is a real contrast."""
        cid = self.propose()
        token = self._approve(cid)
        with patch.object(change, "execute", return_value=(0, "ok", "")), \
             patch.object(change, "_verify_with_retry", return_value=(True, [])), \
             contextlib.redirect_stdout(io.StringIO()):
            rc = change.apply(self.conn, self.host, _args(action="apply", id=cid, token=token))
        self.assertEqual(rc, 0)

    def test_mutated_change_cmd_after_approval_rejects_the_old_token(self):
        cid = self.propose()
        token = self._approve(cid)
        self.conn.execute("UPDATE change_request SET change_cmd=? WHERE id=?",
                          ("rm -rf /", cid))
        with patch.object(change, "execute") as executor, \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            rc = change.apply(self.conn, self.host, _args(action="apply", id=cid, token=token))
        self.assertEqual(rc, 2)
        executor.assert_not_called()

    def test_mutated_inverse_cmd_after_approval_rejects_the_old_token(self):
        cid = self.propose()
        token = self._approve(cid)
        self.conn.execute("UPDATE change_request SET inverse_cmd=? WHERE id=?",
                          ("rm -rf /", cid))
        with patch.object(change, "execute") as executor, \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            rc = change.apply(self.conn, self.host, _args(action="apply", id=cid, token=token))
        self.assertEqual(rc, 2)
        executor.assert_not_called()

    def test_expired_token_from_a_different_approved_at_is_rejected(self):
        cid = self.propose()
        real_token = self._approve(cid)
        row = change._get(self.conn, cid)
        stale_token = change._token(row, "2000-01-01T00:00:00+00:00", row["approved_by"])
        self.assertNotEqual(real_token, stale_token)
        with patch.object(change, "execute") as executor, \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            rc = change.apply(self.conn, self.host, _args(action="apply", id=cid, token=stale_token))
        self.assertEqual(rc, 2)
        executor.assert_not_called()


class RollbackTest(ChangeTestCase):
    """NC-4.4: a rigged-to-fail verify step must trigger the real inverse
    command, land status 'rolled_back', and capture apply/verify/rollback outputs."""

    def _approved(self):
        cid = self.propose(cmd="apply-cmd", inverse="inverse-cmd")
        with patch.object(change, "_run_verify", return_value=(True, {})), \
             contextlib.redirect_stdout(io.StringIO()):
            change.test(self.conn, _args(action="test", id=cid))
        row = change._get(self.conn, cid)
        approved_at = change._now()
        token = change._token(row, approved_at, "tester")
        self.conn.execute(
            "UPDATE change_request SET approved_at=?, approved_by=?, approval_token=?, status='approved' WHERE id=?",
            (approved_at, "tester", token, cid))
        return cid, token

    def test_failed_verify_runs_inverse_and_lands_rolled_back(self):
        cid, token = self._approved()
        calls = []

        def fake_execute(cmd):
            calls.append(cmd)
            return (0, f"ran {cmd}", "")

        verify_results = [(False, [{"attempt": 1, "ok": False}]), (True, [{"attempt": 1, "ok": True}])]
        with patch.object(change, "execute", side_effect=fake_execute), \
             patch.object(change, "_verify_with_retry", side_effect=verify_results), \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            rc = change.apply(self.conn, self.host, _args(action="apply", id=cid, token=token))
        self.assertEqual(rc, 1)
        self.assertEqual(calls, ["apply-cmd", "inverse-cmd"])
        row = change._get(self.conn, cid)
        self.assertEqual(row["status"], "rolled_back")
        self.assertIsNotNone(row["applied_at"])
        self.assertIsNotNone(row["rolled_back_at"])
        output = json.loads(row["apply_output"])
        self.assertEqual(output["apply"]["stdout"], "ran apply-cmd")
        self.assertEqual(output["rollback"]["stdout"], "ran inverse-cmd")
        self.assertIn("verify_attempts", output)
        self.assertIn("rollback_verify", output)

    def test_rollback_appends_a_config_item_row_with_source_change_apply(self):
        cid, token = self._approved()
        verify_results = [(False, []), (True, [])]  # Finding 17: distinct per-call results
        with patch.object(change, "execute", return_value=(0, "", "")), \
             patch.object(change, "_verify_with_retry", side_effect=verify_results), \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            change.apply(self.conn, self.host, _args(action="apply", id=cid, token=token))
        items = self.conn.execute(
            "SELECT key, value, source FROM config_item WHERE key=?", (f"change.{cid}",)).fetchall()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["value"], "rolled_back")
        self.assertEqual(items[0]["source"], "change_apply")

    def test_successful_verify_lands_verified_with_no_rollback_call(self):
        cid, token = self._approved()
        with patch.object(change, "execute", return_value=(0, "", "")) as executor, \
             patch.object(change, "_verify_with_retry", return_value=(True, [])), \
             contextlib.redirect_stdout(io.StringIO()):
            rc = change.apply(self.conn, self.host, _args(action="apply", id=cid, token=token))
        self.assertEqual(rc, 0)
        executor.assert_called_once_with("apply-cmd")
        row = change._get(self.conn, cid)
        self.assertEqual(row["status"], "verified")

class DryRunNeverMutatesTest(ChangeTestCase):
    """`change test` records evidence but never calls execute() (05-f 4.2)."""

    def test_test_never_calls_execute(self):
        cid = self.propose()
        with patch.object(change, "execute") as executor, \
             patch.object(change, "_run_verify", return_value=(False, {"field": "dns_public"})), \
             contextlib.redirect_stdout(io.StringIO()):
            rc = change.test(self.conn, _args(action="test", id=cid))
        self.assertEqual(rc, 0)
        executor.assert_not_called()
        row = change._get(self.conn, cid)
        self.assertEqual(row["status"], "tested")
        self.assertIsNotNone(row["dry_run_output"])
        self.assertIsNotNone(row["dry_run_at"])

if __name__ == "__main__":
    unittest.main()
