"""Tests for the TTY-only approval and capability-input gates. Split out of
test_change.py for the same file-length-budget reason watch.py was split
from __main__.py.

The refusal itself (NC-4.2) is proven with a real subprocess whose stdin is
explicitly a pipe, not a TTY -- mocking `isatty()` would not prove the CLI
process actually refuses under a real non-interactive stdin, which is
exactly the claim being made. Everything else here stays in-process and
hermetic: a real in-memory-equivalent temp SQLite db, `patch.object` for
`sys.stdin.isatty` and `builtins.input`.
"""
import argparse
import contextlib
import io
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from network_checker import change, change_cli, store

REPO = Path(__file__).resolve().parent.parent


def _seed_approvable_change(db_path):
    """A real, dry-run-tested change_request row in `db_path`'s own
    on-disk database, so the subprocess tests below reach the TTY check
    (as an otherwise-approvable row) instead of the "not found" path.
    Regression fix for a mutation-testing finding: the original version of
    this test used a hardcoded id against a brand-new empty database, so
    `change approve 1` returned non-zero via `_missing()` regardless of
    whether the TTY check existed at all -- removing that check entirely
    still passed both tests below. Every subprocess launched against the
    same NETWORK_CHECKER_DB sees this same row."""
    conn = store.open_db(db_path)
    try:
        host = store.host_id(conn, "tty-test-host", "Linux")
        cur = conn.execute(
            "INSERT INTO change_request (created_at, cause, title, change_cmd,"
            " inverse_cmd, verify_probe, status, dry_run_output, dry_run_at)"
            " VALUES ('t', NULL, 'x', 'true', 'true', 'dns_public:ok', 'tested',"
            " 'DRY-RUN: would run: true', 't')")
        return cur.lastrowid, host
    finally:
        conn.close()


class RealSubprocessTTYRefusalTest(unittest.TestCase):
    """NC-4.2, run for real: `echo 1 | python -m network_checker change approve 1`
    must exit non-zero. The exact command the issue specifies, piped stdin
    so it is provably not a TTY. Runs against a real, otherwise-approvable
    row (see _seed_approvable_change) so a passing test actually proves the
    TTY gate fired, not that the row was simply absent."""

    def test_piped_stdin_is_refused_with_a_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = str(Path(tmp) / "network_checker.db")
            cid, _host = _seed_approvable_change(db_path)
            env = dict(os.environ, NETWORK_CHECKER_DB=db_path)
            proc = subprocess.run(
                [sys.executable, "-m", "network_checker", "change", "approve", str(cid)],
                input=f"{cid}\n", capture_output=True, text=True, cwd=REPO,
                env=env, timeout=30)
            self.assertNotEqual(proc.returncode, 0)
            conn = store.open_db(db_path)
            try:
                row = change._get(conn, cid)
                self.assertEqual(row["status"], "tested", "must not have been approved")
                self.assertIsNone(row["approval_token"])
            finally:
                conn.close()

    def test_devnull_stdin_is_also_refused(self):
        """/dev/null is not a pipe or a TTY either -- the same non-zero
        guarantee must hold for any non-interactive stdin, not just a pipe."""
        with tempfile.TemporaryDirectory() as tmp:
            db_path = str(Path(tmp) / "network_checker.db")
            cid, _host = _seed_approvable_change(db_path)
            env = dict(os.environ, NETWORK_CHECKER_DB=db_path)
            with open(os.devnull) as devnull:
                proc = subprocess.run(
                    [sys.executable, "-m", "network_checker", "change", "approve", str(cid)],
                    stdin=devnull, capture_output=True, text=True, cwd=REPO,
                    env=env, timeout=30)
            self.assertNotEqual(proc.returncode, 0)
            conn = store.open_db(db_path)
            try:
                row = change._get(conn, cid)
                self.assertEqual(row["status"], "tested", "must not have been approved")
            finally:
                conn.close()


class ApproveConfirmationFlowTest(unittest.TestCase):
    """The rest of approve()'s logic, exercised in-process: a fake TTY
    (isatty patched True, the only place in this file isatty is mocked --
    never to prove the refusal, only to reach the code path past it) and a
    fake `input()` standing in for the operator's keystrokes."""

    def setUp(self):
        self.conn = store.open_db(":memory:")
        self.addCleanup(self.conn.close)
        store.host_id(self.conn, "approve-test-host", "Linux")

    def _propose_and_test(self):
        cur = self.conn.execute(
            "INSERT INTO change_request (created_at, cause, title, change_cmd,"
            " inverse_cmd, verify_probe, status) VALUES ('t', NULL, 'x', 'true',"
            " 'true', 'dns_public:ok', 'proposed')")
        cid = cur.lastrowid
        with patch.object(change, "_run_verify", return_value=(True, {})), \
             contextlib.redirect_stdout(io.StringIO()):
            change.test(self.conn, _Args(cid))
        return cid

    def test_typing_the_correct_id_approves_and_mints_a_token(self):
        cid = self._propose_and_test()
        out = io.StringIO()
        with patch.object(sys.stdin, "isatty", return_value=True), \
             patch("builtins.input", return_value=str(cid)), \
             contextlib.redirect_stdout(out):
            rc = change.approve(self.conn, _Args(cid))
        self.assertEqual(rc, 0)
        row = change._get(self.conn, cid)
        token = re.search(r"([0-9a-f]{64})", out.getvalue()).group(1)
        self.assertEqual(row["status"], "approved")
        self.assertIsNotNone(row["approval_token"])
        self.assertEqual(row["approved_by"], change._current_user())
        self.assertEqual(token,
                         change._token(row, row["approved_at"], row["approved_by"]))
        self.assertNotEqual(row["approval_token"], token)
        self.assertEqual(row["approval_token"], change._token_digest(token))
        self.assertEqual(out.getvalue().count(token), 1)
        self.assertIn(f"change apply {cid}", out.getvalue())
        self.assertNotIn("--token", out.getvalue())

    def test_typing_the_wrong_id_aborts_without_approving(self):
        cid = self._propose_and_test()
        with patch.object(sys.stdin, "isatty", return_value=True), \
             patch("builtins.input", return_value="not-the-id"), \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            rc = change.approve(self.conn, _Args(cid))
        self.assertNotEqual(rc, 0)
        row = change._get(self.conn, cid)
        self.assertEqual(row["status"], "tested")
        self.assertIsNone(row["approval_token"])

    def test_approving_without_a_recorded_dry_run_is_refused(self):
        cur = self.conn.execute(
            "INSERT INTO change_request (created_at, title, change_cmd, inverse_cmd,"
            " verify_probe, status) VALUES ('t', 'x', 'true', 'true', 'dns_public:ok',"
            " 'proposed')")
        cid = cur.lastrowid
        with patch.object(sys.stdin, "isatty", return_value=True), \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            rc = change.approve(self.conn, _Args(cid))
        self.assertNotEqual(rc, 0)


class ApplyCapabilityInputTest(unittest.TestCase):
    @staticmethod
    def _parser():
        parser = argparse.ArgumentParser()
        sub = parser.add_subparsers(dest="cmd", required=True)
        change_cli.add_subparser(sub)
        return parser

    def test_apply_parser_rejects_a_capability_in_process_arguments(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self._parser().parse_args(["change", "apply", "1", "--token", "secret"])

    def test_noninteractive_apply_refuses_before_the_lifecycle(self):
        args = self._parser().parse_args(["change", "apply", "1"])
        with contextlib.redirect_stderr(io.StringIO()), \
             patch.object(change_cli.sys.stdin, "isatty", return_value=False), \
             patch.object(change_cli.getpass, "getpass") as prompt, \
             patch.object(change, "apply") as apply:
            self.assertNotEqual(change_cli.cli(None, 1, args), 0)
        prompt.assert_not_called()
        apply.assert_not_called()

    def test_interactive_apply_reads_without_echo_then_calls_the_lifecycle(self):
        args = self._parser().parse_args(["change", "apply", "7"])
        with patch.object(change_cli.sys.stdin, "isatty", return_value=True), \
             patch.object(change_cli.getpass, "getpass", return_value="cap") as prompt, \
             patch.object(change, "apply", return_value=0) as apply:
            self.assertEqual(change_cli.cli("conn", 3, args), 0)
        prompt.assert_called_once()
        apply.assert_called_once_with("conn", 3, args, "cap")


class _Args:
    def __init__(self, id_):
        self.id = id_


if __name__ == "__main__":
    unittest.main()
