"""Proposal input validation at the host-scoped command boundary."""
import contextlib
import io
import unittest

from netcheck import change, store
from tests.test_change import ChangeTestCase, _args


class ProposeValidationTest(ChangeTestCase):
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
        rc, err = self._rejected(cause="   ")
        self.assertEqual(rc, 1)
        self.assertIn("--cause must not be blank", err)
        self.assertIsNotNone(self.propose(cause=None))

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

    def test_an_owned_device_reaches_the_frozen_template_gate(self):
        """Ownership succeeds before production authorization fails closed."""
        cur = self.conn.execute(
            "INSERT INTO device (host_id, mac, ip, kind, first_seen, last_seen)"
            " VALUES (?, NULL, 'self', 'self', 't', 't')", (self.host,))
        rc, err = self._rejected(device=cur.lastrowid)
        self.assertEqual(rc, 2)
        self.assertIn("enabled change template", err)
        self.assertNotIn("does not belong", err)
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM change_request").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
