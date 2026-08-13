"""Finding 15 regression tests: keyed HMAC token, key provisioning, forged-
token rejection. Split out of test_change.py/test_change_approve.py for the
same file-length-budget reason those two are already split from each other
(see test_change_approve.py's own docstring)."""
import contextlib
import hashlib
import io
import os
import stat
import sys
import tempfile
import unittest
from base64 import urlsafe_b64encode
from pathlib import Path
from unittest.mock import patch

from netcheck import change, store
from tests.test_change import _args


def _propose_tested_approved(conn, **overrides):
    with contextlib.redirect_stdout(io.StringIO()):
        change.propose(conn, _args(**overrides))
    cid = conn.execute(
        "SELECT id FROM change_request ORDER BY id DESC LIMIT 1").fetchone()["id"]
    with patch.object(change, "_run_verify", return_value=(True, {})), \
         contextlib.redirect_stdout(io.StringIO()):
        change.test(conn, _args(action="test", id=cid))
    row = change._get(conn, cid)
    approved_at = change._now()
    token = change._token(row, approved_at, "tester")
    conn.execute(
        "UPDATE change_request SET approved_at=?, approved_by=?, approval_token=?,"
        " status='approved' WHERE id=?", (approved_at, "tester", token, cid))
    return cid, token


class KeyProvisioningTest(unittest.TestCase):
    """_load_or_create_key(): mirrors
    agentic-command-center/gui/server.mjs's loadOrCreateToken/ownerOnly."""

    def test_absent_file_mints_a_fresh_32_byte_key_with_mode_0600(self):
        with tempfile.TemporaryDirectory() as tmp:
            key_file = Path(tmp) / "key"
            with patch.dict(os.environ, {"NETCHECK_CHANGE_KEY_FILE": str(key_file)}):
                key = change._load_or_create_key()
            self.assertTrue(key_file.exists())
            self.assertEqual(len(key), 32)
            if sys.platform != "win32":
                self.assertEqual(stat.S_IMODE(key_file.stat().st_mode), 0o600)

    def test_an_existing_0600_file_is_trusted_and_reused_verbatim(self):
        with tempfile.TemporaryDirectory() as tmp:
            key_file = Path(tmp) / "key"
            with patch.dict(os.environ, {"NETCHECK_CHANGE_KEY_FILE": str(key_file)}):
                first = change._load_or_create_key()
                second = change._load_or_create_key()
            self.assertEqual(first, second)

    @unittest.skipIf(sys.platform == "win32", "POSIX permission bits only")
    def test_a_loosely_permissioned_existing_file_is_rejected_and_rewritten(self):
        """The concrete attack this check exists to close: a same-user
        process pre-creates a world-readable key file with an
        attacker-known value before this module ever runs."""
        with tempfile.TemporaryDirectory() as tmp:
            key_file = Path(tmp) / "key"
            planted = b"x" * 32
            key_file.write_text(urlsafe_b64encode(planted).decode() + "\n")
            os.chmod(key_file, 0o644)
            with patch.dict(os.environ, {"NETCHECK_CHANGE_KEY_FILE": str(key_file)}):
                key = change._load_or_create_key()
            self.assertNotEqual(key, planted)
            self.assertEqual(stat.S_IMODE(key_file.stat().st_mode), 0o600,
                             "the loosely-permissioned file must be re-tightened")

    def test_two_different_key_files_produce_different_tokens_for_identical_material(self):
        """Proves the token is actually keyed: identical row/approved_at/
        verifier, different key file, different digest -- would fail under
        the pre-fix unkeyed formula, which ignores any key entirely."""
        row = {"id": 1, "change_cmd": "true", "inverse_cmd": "true", "dry_run_output": "x"}
        with tempfile.TemporaryDirectory() as tmp:
            f1, f2 = Path(tmp) / "k1", Path(tmp) / "k2"
            with patch.dict(os.environ, {"NETCHECK_CHANGE_KEY_FILE": str(f1)}):
                t1 = change._token(row, "2026-01-01T00:00:00+00:00", "tester")
            with patch.dict(os.environ, {"NETCHECK_CHANGE_KEY_FILE": str(f2)}):
                t2 = change._token(row, "2026-01-01T00:00:00+00:00", "tester")
        self.assertNotEqual(t1, t2)

    def test_default_key_file_is_outside_the_default_db_directory(self):
        """The whole point of Finding 15's key: it must not share a
        directory with netcheck.db (__main__.py's NETCHECK_DB default,
        ~/.netcheck/netcheck.db)."""
        self.assertNotEqual(change._key_file().parent, Path.home() / ".netcheck")


class TokenForgeryRejectionTest(unittest.TestCase):
    """The core Finding 15 regression test: reproduce the OLD formula the
    review quoted verbatim (unkeyed sha256 over delimiter-free
    concatenation) and prove apply() now refuses a token minted that way --
    the exact attack described ("any process with write access to the
    SQLite file can compute this token itself")."""

    def setUp(self):
        self.conn = store.open_db(":memory:")
        self.addCleanup(self.conn.close)
        self.host = store.host_id(self.conn, "forge-test-host", "Linux")

    @staticmethod
    def _old_style_forged_token(row, approved_at):
        evidence = hashlib.sha256((row["dry_run_output"] or "").encode()).hexdigest()
        material = f"{row['id']}{row['change_cmd']}{row['inverse_cmd']}{evidence}{approved_at}"
        return hashlib.sha256(material.encode()).hexdigest()

    def test_a_forged_old_style_token_is_rejected(self):
        cid, _real_token = _propose_tested_approved(self.conn)
        row = change._get(self.conn, cid)
        forged = self._old_style_forged_token(row, row["approved_at"])
        # Sanity: not vacuous -- the forged value must differ from the
        # real, currently-stored token, or the old formula is still live.
        self.assertNotEqual(forged, row["approval_token"])
        with patch.object(change, "execute") as executor, \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            rc = change.apply(self.conn, self.host,
                              _args(action="apply", id=cid, token=forged))
        self.assertEqual(rc, 2)
        executor.assert_not_called()
        row = change._get(self.conn, cid)
        self.assertEqual(row["status"], "approved", "a rejected apply must not claim the row")

    def test_the_legitimately_minted_token_still_applies_cleanly(self):
        """Positive case, so the rejection above is a real contrast."""
        cid, real_token = _propose_tested_approved(self.conn)
        with patch.object(change, "execute", return_value=(0, "ok", "")), \
             patch.object(change, "_verify_with_retry", return_value=(True, [])), \
             contextlib.redirect_stdout(io.StringIO()):
            rc = change.apply(self.conn, self.host,
                              _args(action="apply", id=cid, token=real_token))
        self.assertEqual(rc, 0)
        row = change._get(self.conn, cid)
        self.assertEqual(row["status"], "verified")

    def test_mutated_approved_by_after_approval_rejects_the_old_token(self):
        """Finding 15c: approved_by is folded into the HMAC material
        exactly like change_cmd/inverse_cmd already were (test_change.py's
        TokenBindingTest covers those two) -- tampering with the
        verifier-identity column directly in the row must invalidate a
        previously issued token the same way."""
        cid, token = _propose_tested_approved(self.conn)
        self.conn.execute("UPDATE change_request SET approved_by=? WHERE id=?",
                          ("someone-else", cid))
        with patch.object(change, "execute") as executor, \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            rc = change.apply(self.conn, self.host,
                              _args(action="apply", id=cid, token=token))
        self.assertEqual(rc, 2)
        executor.assert_not_called()


if __name__ == "__main__":
    unittest.main()
