"""Proves tagging and rollback behave as the release contract says (#504, AC3)."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import release


def git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def commit(repo, text):
    (repo / "VERSION").write_text(text)
    git(repo, "add", "VERSION")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", text)


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp())
        git(self.repo, "init", "-q")
        self.log = release.ReleaseLog(Path(tempfile.mkdtemp()) / "releases.json")
        commit(self.repo, "1")

    def tags(self):
        return set(subprocess.run(["git", "-C", str(self.repo), "tag"], capture_output=True, text=True).stdout.split())

    def sha(self):
        return release.git(self.repo, "rev-parse", "HEAD")

    def test_a_healthy_build_is_tagged_at_its_exact_sha(self):
        code, _ = release.tag(self.repo, self.log, "v1", "true")
        self.assertEqual(code, 0)
        self.assertIn("release-v1", self.tags())
        self.assertEqual(release.git(self.repo, "rev-parse", "release-v1^{commit}"), self.sha())

    def test_a_failed_health_check_tags_nothing_and_records_nothing(self):
        release.tag(self.repo, self.log, "v1", "true")
        commit(self.repo, "2")
        before = self.log.read()
        code, message = release.tag(self.repo, self.log, "v2", "false")
        self.assertEqual(code, 2)
        self.assertIn("nothing tagged", message)
        self.assertEqual(self.tags(), {"release-v1"})
        self.assertEqual(self.log.read(), before)

    def test_a_dirty_tree_is_refused(self):
        (self.repo / "scratch.txt").write_text("uncommitted")
        with self.assertRaises(SystemExit):
            release.tag(self.repo, self.log, "v1", "true")
        self.assertEqual(self.tags(), set())

    def test_rollback_returns_to_the_previous_tagged_sha(self):
        release.tag(self.repo, self.log, "v1", "true")
        first = self.sha()
        commit(self.repo, "2")
        release.tag(self.repo, self.log, "v2", "true")
        code, _ = release.rollback(self.repo, self.log, "true", "true")
        self.assertEqual(code, 0)
        state = self.log.read()
        self.assertEqual(state["current"], "v1")
        self.assertEqual(state["releases"][-1]["sha"], first)

    def test_a_failed_rollback_is_recorded_not_silent(self):
        release.tag(self.repo, self.log, "v1", "true")
        commit(self.repo, "2")
        release.tag(self.repo, self.log, "v2", "true")
        code, message = release.rollback(self.repo, self.log, "true", "false")
        self.assertEqual(code, 3)
        self.assertIn("failed", message)
        self.assertEqual(self.log.read()["releases"][-1]["status"], "failed-rollback")

    def test_a_failed_health_check_after_deploy_rolls_back_and_tags_nothing(self):
        deployed = Path(tempfile.mkdtemp()) / "deployed.txt"
        deploy = f"echo {{sha}} > {deployed}"
        release.tag(self.repo, self.log, "v1", "true", deploy)
        first = self.sha()
        commit(self.repo, "2")
        bad = self.sha()
        health = f'test "$(cat {deployed})" != "{bad}"'
        code, message = release.tag(self.repo, self.log, "v2", health, deploy)
        self.assertEqual(code, 2)
        self.assertIn("rolled back to release-v1", message)
        self.assertEqual(self.tags(), {"release-v1"})
        self.assertEqual(deployed.read_text().strip(), first)
        state = self.log.read()
        self.assertEqual(state["current"], "v1")
        self.assertEqual(state["releases"][-1], {"name": "v2", "sha": bad, "status": "rejected",
                                                 "at": state["releases"][-1]["at"]})

    def test_a_failed_health_check_after_deploy_with_a_failed_rollback_is_recorded(self):
        release.tag(self.repo, self.log, "v1", "true", "true")
        commit(self.repo, "2")
        code, message = release.tag(self.repo, self.log, "v2", "false", "true")
        self.assertEqual(code, 3)
        self.assertIn("failed", message)
        self.assertEqual(self.log.read()["releases"][-1]["status"], "failed-rollback")
        self.assertEqual(self.tags(), {"release-v1"})

    def test_a_failed_health_check_with_no_previous_release_is_rejected_not_tagged(self):
        code, message = release.tag(self.repo, self.log, "v1", "false", "true")
        self.assertEqual(code, 2)
        self.assertIn("no previous release", message)
        self.assertEqual(self.tags(), set())
        self.assertEqual(self.log.read()["releases"][-1]["status"], "rejected")

    def test_a_failed_canary_deploys_nothing_and_tags_nothing(self):
        """canary-missing: the candidate must prove itself before the live stack changes."""
        deployed = Path(tempfile.mkdtemp()) / "deployed.txt"
        code, message = release.tag(self.repo, self.log, "v1", "true", f"echo {{sha}} > {deployed}",
                                    canary_cmd="false")
        self.assertEqual(code, 2)
        self.assertIn("canary failed", message)
        self.assertFalse(deployed.exists())
        self.assertEqual(self.tags(), set())

    def test_a_failed_invariant_rolls_back_and_tags_nothing(self):
        """invariant-breach: a healthy but corrupt release is rejected and rolled back."""
        release.tag(self.repo, self.log, "v1", "true", "true")
        commit(self.repo, "2")
        code, message = release.tag(self.repo, self.log, "v2", "true", "true", invariant_cmd="false")
        self.assertEqual(code, 2)
        self.assertIn("invariant check failed", message)
        self.assertIn("rolled back to release-v1", message)
        self.assertEqual(self.tags(), {"release-v1"})

    def test_missing_or_empty_telemetry_tags_nothing(self):
        """missing-telemetry: a release nobody observed is never tagged."""
        for cmd in ("false", "true", "echo '{}'", "echo not-json"):
            with self.subTest(cmd=cmd):
                code, message = release.tag(self.repo, self.log, "v1", "true", telemetry_cmd=cmd)
                self.assertEqual(code, 2)
                self.assertIn("telemetry check failed", message)
                self.assertEqual(self.tags(), set())

    def test_a_release_carries_a_signed_attestation_that_verifies(self):
        """missing-attestation: the tag is backed by a signed manifest of SHA, tree and gates."""
        code, _ = release.tag(self.repo, self.log, "v1", "true", canary_cmd="true",
                              invariant_cmd="true", telemetry_cmd="echo '{\"services\": {\"a\": 1}}'")
        self.assertEqual(code, 0)
        entry = self.log.read()["releases"][-1]
        doc = json.loads(Path(entry["attestation"]).read_text())
        self.assertEqual(doc["payload"]["sha"], self.sha())
        self.assertEqual(set(doc["payload"]["checks"]), {"canary", "health", "invariant", "telemetry"})
        self.assertEqual(release.verify(self.repo, self.log, "v1")[0], 0)

    def test_a_tampered_attestation_fails_verification(self):
        """Catches an edited manifest or a moved tag passing as attested."""
        release.tag(self.repo, self.log, "v1", "true")
        path = Path(self.log.read()["releases"][-1]["attestation"])
        doc = json.loads(path.read_text())
        doc["payload"]["checks"]["health"] = "forged"
        path.write_text(json.dumps(doc))
        code, message = release.verify(self.repo, self.log, "v1")
        self.assertEqual(code, 3)
        self.assertIn("signature", message)

    def test_a_moved_tag_fails_verification(self):
        release.tag(self.repo, self.log, "v1", "true")
        commit(self.repo, "2")
        git(self.repo, "tag", "-f", "release-v1")
        code, message = release.verify(self.repo, self.log, "v1")
        self.assertEqual(code, 3)
        self.assertIn("no longer points", message)

    def test_the_signing_key_is_owner_only(self):
        release.tag(self.repo, self.log, "v1", "true")
        key = self.log.path.parent / "release-key"
        self.assertEqual(key.stat().st_mode & 0o777, 0o600)

    def test_rollback_needs_a_previous_release(self):
        release.tag(self.repo, self.log, "v1", "true")
        code, message = release.rollback(self.repo, self.log, "true", "true")
        self.assertEqual(code, 2)
        self.assertIn("no previous", message)


if __name__ == "__main__":
    unittest.main()
