"""Finding 61 regression tests (independent security review): propose()'s
input validation (blank cmd/inverse/verify/cause, --device ownership).
Split out of test_change.py for the same file-budget reason
test_change_key.py/test_change_approve.py/test_change_concurrency.py/
test_change_execute.py/test_change_outcomes.py already are."""
import contextlib
import io
import unittest

from netcheck import change, store
from tests.test_change import ChangeTestCase, _args


class ProposeValidationTest(ChangeTestCase):
    """propose() rejects blank cmd/inverse/verify and a --device not owned
    by this host, before any row is ever inserted -- and a device that IS
    owned still succeeds."""

    def _rejected(self, **overrides):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = change.propose(self.conn, self.host, _args(**overrides))
        return rc, err.getvalue()

    def test_blank_cmd_is_rejected_with_a_clear_error_and_no_row_inserted(self):
        rc, err = self._rejected(cmd="   ")
        self.assertEqual(rc, 1)
        self.assertIn("--cmd must not be blank", err)
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM change_request").fetchone()[0], 0)

    def test_blank_inverse_is_rejected(self):
        rc, err = self._rejected(inverse="")
        self.assertEqual(rc, 1)
        self.assertIn("--inverse must not be blank", err)

    def test_blank_verify_is_rejected(self):
        rc, err = self._rejected(verify="  ")
        self.assertEqual(rc, 1)
        self.assertIn("--verify must not be blank", err)

    def test_a_blank_string_cause_is_rejected_but_a_missing_cause_is_not(self):
        """--cause is optional (None means "no cause"); an explicit blank
        STRING is a different, rejectable thing."""
        rc, err = self._rejected(cause="   ")
        self.assertEqual(rc, 1)
        self.assertIn("--cause must not be blank", err)
        self.assertIsNotNone(self.propose(cause=None))  # positive control, unchanged

    def test_a_device_id_not_belonging_to_this_host_is_rejected(self):
        other_host = store.host_id(self.conn, "other-host", "Linux")
        cur = self.conn.execute(
            "INSERT INTO device (host_id, mac, ip, kind, first_seen, last_seen)"
            " VALUES (?, NULL, 'self', 'self', 't', 't')", (other_host,))
        rc, err = self._rejected(device=cur.lastrowid)
        self.assertEqual(rc, 1)
        self.assertIn("does not belong to this host", err)
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM change_request").fetchone()[0], 0)

    def test_a_nonexistent_device_id_is_also_rejected(self):
        rc, err = self._rejected(device=999999)
        self.assertEqual(rc, 1)
        self.assertIn("does not belong to this host", err)

    def test_a_device_id_belonging_to_this_host_succeeds(self):
        """Positive control: device-ownership validation does not reject a
        legitimately-owned device."""
        cur = self.conn.execute(
            "INSERT INTO device (host_id, mac, ip, kind, first_seen, last_seen)"
            " VALUES (?, NULL, 'self', 'self', 't', 't')", (self.host,))
        cid = self.propose(device=cur.lastrowid)
        row = change._get(self.conn, cid)
        self.assertEqual(row["device_id"], cur.lastrowid)
        self.assertEqual(row["status"], "proposed")


if __name__ == "__main__":
    unittest.main()
