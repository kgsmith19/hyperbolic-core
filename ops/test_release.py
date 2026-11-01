"""Proves tagging and rollback behave as the release contract says (#504, AC3)."""

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

    def test_rollback_needs_a_previous_release(self):
        release.tag(self.repo, self.log, "v1", "true")
        code, message = release.rollback(self.repo, self.log, "true", "true")
        self.assertEqual(code, 2)
        self.assertIn("no previous", message)


if __name__ == "__main__":
    unittest.main()
