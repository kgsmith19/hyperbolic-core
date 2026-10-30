"""Host isolation for every Network Checker change lifecycle surface."""
import argparse
import contextlib
import io
import unittest
from unittest.mock import patch

from network_checker import change, change_cli, store


def _args(action, change_id=None, **extra):
    values = {"action": action, "id": change_id, "token": "cap", "status": None}
    values.update(extra)
    return argparse.Namespace(**values)


def _proposal(**extra):
    values = {
        "device": None,
        "cause": "router_dns",
        "title": "Switch to public DNS resolvers",
        "cmd": "tools/fix_dns.sh",
        "inverse": "tools/fix_dns.sh --restore",
        "verify": "dns_public:ok",
    }
    values.update(extra)
    return argparse.Namespace(**values)


class CrossHostLifecycleTest(unittest.TestCase):
    def setUp(self):
        self.conn = store.open_db(":memory:")
        self.addCleanup(self.conn.close)
        self.owner = store.host_id(self.conn, "owner-host", "Linux")
        self.other = store.host_id(self.conn, "other-host", "Linux")

    def _change(self, status="proposed"):
        return self.conn.execute(
            "INSERT INTO change_request (created_at,host_id,title,change_cmd,"
            " inverse_cmd,verify_probe,dry_run_output,dry_run_at,approved_at,"
            " approved_by,approval_token,status)"
            " VALUES ('t',?,'owned','true','true','dns_public:ok','evidence',"
            " 't','approved-at','tester',?,?)",
            (self.owner, change._token_digest("cap"), status),
        ).lastrowid

    def _run(self, host_id, action, change_id, **extra):
        with contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            return change_cli.cli(self.conn, host_id, _args(action, change_id, **extra))

    def test_cross_host_test_approve_reject_and_apply_never_reach_real_seams(self):
        proposed = self._change("proposed")
        tested = self._change("tested")
        approved = self._change("approved")
        with patch.object(change, "_run_verify") as verifier:
            self.assertNotEqual(self._run(self.other, "test", proposed), 0)
        verifier.assert_not_called()
        with patch.object(change.sys.stdin, "isatty", return_value=True), \
             patch("builtins.input") as prompt:
            self.assertNotEqual(self._run(self.other, "approve", tested), 0)
        prompt.assert_not_called()
        self.assertNotEqual(self._run(self.other, "reject", tested), 0)
        with patch.object(change, "execute") as executor, \
             patch.object(change, "_token", return_value="cap"), \
             patch.object(change_cli.sys.stdin, "isatty", return_value=True), \
             patch.object(change_cli.getpass, "getpass", return_value="cap"):
            self.assertNotEqual(self._run(self.other, "apply", approved), 0)
        executor.assert_not_called()

    def test_show_list_and_verify_reveal_only_the_current_host(self):
        cid = self._change("tested")
        self.assertNotEqual(self._run(self.other, "show", cid), 0)
        with patch.object(change, "_run_verify") as verifier:
            self.assertNotEqual(self._run(self.other, "verify", cid), 0)
        verifier.assert_not_called()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(change_cli.list_(self.conn, self.other, _args("list")), 0)
        self.assertEqual(out.getvalue(), "")

    def test_owner_mutations_have_database_host_predicates(self):
        cid = self._change("proposed")
        statements = []
        self.conn.set_trace_callback(statements.append)
        try:
            with patch.object(change, "_run_verify", return_value=(True, {})):
                self.assertEqual(self._run(self.owner, "test", cid), 0)
        finally:
            self.conn.set_trace_callback(None)
        updates = [s.lower() for s in statements if s.lstrip().lower().startswith("update change_request")]
        self.assertTrue(updates)
        self.assertTrue(all("host_id" in statement for statement in updates), updates)

    def test_host_scoped_propose_rejects_every_request_while_registry_is_empty(self):
        device = self.conn.execute(
            "INSERT INTO device (host_id,mac,ip,kind,first_seen,last_seen)"
            " VALUES (?,NULL,'192.0.2.1','client','t','t')", (self.other,)
        ).lastrowid
        for args in (_proposal(), _proposal(device=device),
                     _proposal(title="arbitrary", cmd="rm -rf /")):
            with self.subTest(args=args), contextlib.redirect_stderr(io.StringIO()):
                self.assertNotEqual(change.propose(self.conn, self.owner, args), 0)
        self.assertEqual(self.conn.execute(
            "SELECT count(*) FROM change_request").fetchone()[0], 0)

    def test_host_scoped_propose_validates_blanks_before_template_authorization(self):
        for field in ("cause", "cmd", "inverse", "verify"):
            with self.subTest(field=field):
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    rc = change.propose(
                        self.conn, self.owner, _proposal(**{field: "   "}))
                self.assertEqual(rc, 1)
                self.assertIn(f"--{field} must not be blank", err.getvalue())

    def test_host_scoped_propose_validates_device_ownership_before_template_gate(self):
        device = self.conn.execute(
            "INSERT INTO device (host_id,mac,ip,kind,first_seen,last_seen)"
            " VALUES (?,NULL,'192.0.2.2','client','t','t')", (self.other,)
        ).lastrowid
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = change.propose(self.conn, self.owner, _proposal(device=device))
        self.assertEqual(rc, 1)
        self.assertIn("does not belong to this host", err.getvalue())

    def test_runtime_template_mutation_cannot_expand_the_command_allowlist(self):
        unsafe = {"cause": "router_dns", "title": "Unsafe", "change_cmd": "rm -rf /",
                  "inverse_cmd": "true", "verify_probe": "dns_public:ok"}
        args = _proposal(title="Unsafe", cmd="rm -rf /", inverse="true")
        with patch.dict(change.TEMPLATES, {"unsafe": unsafe}), \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertNotEqual(change.propose(self.conn, self.owner, args), 0)
        self.assertEqual(
            self.conn.execute("SELECT count(*) FROM change_request").fetchone()[0], 0)

    def test_unscoped_direct_propose_keeps_the_legacy_raw_api(self):
        args = _proposal(cause=None, title="legacy", cmd="apply-cmd",
                         inverse="inverse-cmd", verify="custom:ok")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(change.propose(self.conn, args), 0)
        row = self.conn.execute(
            "SELECT host_id,change_cmd,inverse_cmd,verify_probe FROM change_request"
        ).fetchone()
        self.assertEqual(tuple(row), (None, "apply-cmd", "inverse-cmd", "custom:ok"))

    def test_single_host_list_includes_legacy_unscoped_rows(self):
        self.conn.execute("DELETE FROM hosts WHERE id=?", (self.other,))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(change.propose(
                self.conn, _proposal(title="legacy-visible")), 0)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(change_cli.list_(
                self.conn, self.owner, _args("list", status="proposed")), 0)
        self.assertIn("legacy-visible", out.getvalue())

    def test_host_id_is_immutable_in_the_database(self):
        cid = self._change()
        with self.assertRaises(Exception):
            self.conn.execute("UPDATE change_request SET host_id=? WHERE id=?",
                              (self.other, cid))


if __name__ == "__main__":
    unittest.main()
