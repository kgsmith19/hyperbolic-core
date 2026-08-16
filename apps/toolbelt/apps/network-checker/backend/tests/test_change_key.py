"""Finding 15 regressions: keyed tokens, key provisioning, and forgery rejection."""
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

from network_checker import change, store
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
        " status='approved' WHERE id=?",
        (approved_at, "tester", change._token_digest(token), cid))
    return cid, token


class KeyProvisioningTest(unittest.TestCase):
    """Owner-only key provisioning."""

    def test_absent_file_mints_a_fresh_32_byte_key_with_mode_0600(self):
        with tempfile.TemporaryDirectory() as tmp:
            key_file = Path(tmp) / "key"
            with patch.dict(os.environ, {"NETWORK_CHECKER_CHANGE_KEY_FILE": str(key_file)}):
                key = change._load_or_create_key()
            self.assertTrue(key_file.exists())
            self.assertEqual(len(key), 32)
            if sys.platform != "win32":
                self.assertEqual(stat.S_IMODE(key_file.stat().st_mode), 0o600)

    def test_an_existing_0600_file_is_trusted_and_reused_verbatim(self):
        with tempfile.TemporaryDirectory() as tmp:
            key_file = Path(tmp) / "key"
            with patch.dict(os.environ, {"NETWORK_CHECKER_CHANGE_KEY_FILE": str(key_file)}):
                first = change._load_or_create_key()
                second = change._load_or_create_key()
            self.assertEqual(first, second)

    def test_a_short_decodable_key_is_rejected_and_replaced(self):
        with tempfile.TemporaryDirectory() as tmp:
            key_file = Path(tmp) / "key"
            key_file.write_text(urlsafe_b64encode(b"x").decode() + "\n")
            if sys.platform != "win32":
                os.chmod(key_file, 0o600)
            with patch.dict(os.environ, {"NETWORK_CHECKER_CHANGE_KEY_FILE": str(key_file)}):
                key = change._load_or_create_key()
            self.assertEqual(len(key), 32)
            self.assertNotEqual(key, b"x")

    @unittest.skipIf(sys.platform == "win32", "POSIX permission bits only")
    def test_a_loosely_permissioned_existing_file_is_rejected_and_rewritten(self):
        """Reject a pre-created, world-readable key with an attacker-known value."""
        with tempfile.TemporaryDirectory() as tmp:
            key_file = Path(tmp) / "key"
            planted = b"x" * 32
            key_file.write_text(urlsafe_b64encode(planted).decode() + "\n")
            os.chmod(key_file, 0o644)
            with patch.dict(os.environ, {"NETWORK_CHECKER_CHANGE_KEY_FILE": str(key_file)}):
                key = change._load_or_create_key()
            self.assertNotEqual(key, planted)
            self.assertEqual(stat.S_IMODE(key_file.stat().st_mode), 0o600,
                             "the loosely-permissioned file must be re-tightened")

    def test_two_different_key_files_produce_different_tokens_for_identical_material(self):
        """Identical material with different key files must produce different tokens."""
        row = {"id": 1, "change_cmd": "true", "inverse_cmd": "true", "dry_run_output": "x"}
        with tempfile.TemporaryDirectory() as tmp:
            f1, f2 = Path(tmp) / "k1", Path(tmp) / "k2"
            with patch.dict(os.environ, {"NETWORK_CHECKER_CHANGE_KEY_FILE": str(f1)}):
                t1 = change._token(row, "2026-01-01T00:00:00+00:00", "tester")
            with patch.dict(os.environ, {"NETWORK_CHECKER_CHANGE_KEY_FILE": str(f2)}):
                t2 = change._token(row, "2026-01-01T00:00:00+00:00", "tester")
        self.assertNotEqual(t1, t2)

    def test_default_key_file_is_outside_the_default_db_directory(self):
        """Keep the key out of the default database directory."""
        self.assertNotEqual(change._key_file().parent, Path.home() / ".network-checker")


class TokenMaterialBindingTest(unittest.TestCase):
    def test_every_authorized_field_changes_the_capability(self):
        row = {
            "id": 7,
            "host_id": 2,
            "device_id": 3,
            "cause": "router_dns",
            "title": "Fix DNS",
            "change_cmd": "python -m network_checker --version",
            "inverse_cmd": "python3 -m network_checker --version",
            "verify_probe": "dns_public:ok",
            "dry_run_output": "evidence",
        }
        baseline = change._token(row, "2026-01-01T00:00:00+00:00", "tester")
        mutations = {
            "host_id": 4,
            "device_id": 5,
            "cause": "dns",
            "title": "Different title",
            "change_cmd": "python3 -m network_checker --version",
            "inverse_cmd": "python -m network_checker --version",
            "verify_probe": "gw:ok",
            "dry_run_output": "different evidence",
        }
        for field, value in mutations.items():
            changed = dict(row, **{field: value})
            with self.subTest(field=field):
                self.assertNotEqual(
                    baseline,
                    change._token(changed, "2026-01-01T00:00:00+00:00", "tester"))

    def test_null_and_text_values_have_distinct_hmac_material(self):
        row = {
            "id": 7, "host_id": 2, "device_id": None, "cause": None,
            "title": "Fix DNS", "change_cmd": "python -m network_checker --version",
            "inverse_cmd": "python3 -m network_checker --version",
            "verify_probe": "dns_public:ok", "dry_run_output": "evidence",
        }
        baseline = change._token(row, "2026-01-01T00:00:00+00:00", "tester")
        mutations = {"device_id": "None", "cause": "None", "host_id": "2"}
        for field, value in mutations.items():
            with self.subTest(field=field):
                self.assertNotEqual(
                    baseline,
                    change._token(dict(row, **{field: value}),
                                  "2026-01-01T00:00:00+00:00", "tester"))

    def test_null_evidence_and_verifier_do_not_alias_empty_text(self):
        row = {
            "id": 7, "host_id": 2, "device_id": None, "cause": None,
            "title": "Fix DNS", "change_cmd": "python -m network_checker --version",
            "inverse_cmd": "python3 -m network_checker --version",
            "verify_probe": "dns_public:ok", "dry_run_output": None,
        }
        approved_at = "2026-01-01T00:00:00+00:00"
        self.assertNotEqual(change._token(row, approved_at, "tester"),
                            change._token(dict(row, dry_run_output=""), approved_at,
                                          "tester"))
        self.assertNotEqual(change._token(row, approved_at, None),
                            change._token(row, approved_at, ""))


class TokenForgeryRejectionTest(unittest.TestCase):
    """Prove apply rejects tokens minted with the old unkeyed formula."""

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
        # Sanity: not vacuous -- the forged value must differ from the stored
        # digest, or the old raw-token representation is still live.
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

    def test_rejection_never_echoes_the_supplied_capability(self):
        cid, _token = _propose_tested_approved(self.conn)
        supplied = "do-not-print-this-capability"
        err = io.StringIO()
        with patch.object(change, "execute") as executor, \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(err):
            rc = change.apply(self.conn, self.host,
                              _args(action="apply", id=cid, token=supplied))
        self.assertEqual(rc, 2)
        self.assertNotIn(supplied, err.getvalue())
        executor.assert_not_called()

    def test_non_string_capability_fails_closed_before_execution(self):
        cid, _token = _propose_tested_approved(self.conn)
        with patch.object(change, "execute") as executor, \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            rc = change.apply(self.conn, self.host,
                              _args(action="apply", id=cid, token=object()))
        self.assertEqual(rc, 2)
        executor.assert_not_called()

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
        """Binding approved_by makes verifier-identity tampering invalidate the token."""
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
