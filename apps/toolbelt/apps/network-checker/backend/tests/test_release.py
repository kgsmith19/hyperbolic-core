"""Release helper contracts that keep monorepo tags application-scoped."""
import importlib.util
import contextlib
import hashlib
import io
import json
import re
import tempfile
from pathlib import Path
from unittest import TestCase, mock


_PATH = Path(__file__).resolve().parents[1] / "tools" / "release.py"
_SPEC = importlib.util.spec_from_file_location("netcheck_release", _PATH)
release = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(release)


class LastTagTest(TestCase):
    def test_last_tag_ignores_other_toolbelt_applications(self):
        completed = mock.Mock(returncode=0, stdout="network-checker-v1.2.3\n")
        with mock.patch.object(release.subprocess, "run", return_value=completed) as run:
            self.assertEqual(release._last_tag(), "network-checker-v1.2.3")
        self.assertEqual(
            run.call_args.args[0],
            ["git", "describe", "--tags", "--abbrev=0", "--match", "network-checker-v[0-9]*"],
        )
        self.assertEqual(run.call_args.kwargs["cwd"], release.APP_ROOT)


class ChangelogEntriesTest(TestCase):
    def test_changelog_is_scoped_to_network_checker_directory(self):
        completed = mock.Mock(returncode=0, stdout="Fix scan output\n")
        with mock.patch.object(release.subprocess, "run", return_value=completed) as run:
            self.assertEqual(release.changelog_entries("network-checker-v1.2.3"), ["Fix scan output"])

        self.assertEqual(
            run.call_args.args[0],
            [
                "git",
                "log",
                "--reverse",
                "--format=%s",
                "network-checker-v1.2.3..HEAD",
                "--",
                ".",
            ],
        )
        self.assertEqual(run.call_args.kwargs["cwd"], release.APP_ROOT)


class VersionSourceOfTruthTest(TestCase):
    def test_runtime_version_matches_manifest_and_registered_manifest(self):
        self.assertEqual(release.check_version_files(), "1.0.0")

    def test_registered_hash_is_regenerated_from_the_canonical_manifest(self):
        manifest = json.loads(release.MANIFEST.read_text())
        registered_hash = re.search(
            r"^\s*'([0-9a-f]{64})',\s*$", release.REGISTRY.read_text(), re.MULTILINE
        )
        self.assertEqual(registered_hash.group(1), release.manifest_hash(manifest))

    def test_applied_registration_migration_content_is_immutable(self):
        applied = release.REGISTRY.parent / "20260812250000_register_network-checker.sql"
        # Ignore EOF-only blank-line normalization; pin every SQL byte.
        normalized = applied.read_bytes().rstrip() + b"\n"
        self.assertEqual(
            hashlib.sha256(normalized).hexdigest(),
            "3f4836acc0e6f712e4aebcb3bc007e4b97060b5e2f02f7830f176b267c8ea8df",
        )

    def test_current_registration_has_a_non_deleting_restorative_down_pair(self):
        down = release.REGISTRY.with_name(f"{release.REGISTRY.stem}_down.sql")
        text = down.read_text().lower()
        self.assertNotIn("delete from core.app", text)
        self.assertNotRegex(text, r"\bstatus\s*=")
        self.assertIn("version       = '0.1.0'", text)
        self.assertIn(
            '"networkegress":["ipapi.co","api.ipify.org","status.anthropic.com",'
            '"api.anthropic.com","1.1.1.1"]', text)
        self.assertIn("146e208e509e124d6ca4a74cb0e6f7139acd2fd94c1516078e28c55e5fad2a87", text)

    def test_bump_fails_closed_without_rewriting_applied_migration(self):
        stderr = io.StringIO()
        with mock.patch.object(release.Path, "write_text") as write, \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(stderr):
            rc = release.main(["bump", "patch"])
        self.assertNotEqual(rc, 0)
        write.assert_not_called()
        self.assertIn("already-applied registration migration", stderr.getvalue())

    def test_check_rejects_runtime_manifest_version_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            init = root / "__init__.py"
            manifest = root / "tool.json"
            registry = root / release.REGISTRY.name
            init.write_text(release.INIT_PY.read_text())
            manifest.write_text(release.MANIFEST.read_text().replace('"1.0.0"', '"9.9.9"', 1))
            registry.write_text(release.REGISTRY.read_text())

            with self.assertRaisesRegex(ValueError, "version mismatch"):
                release.check_version_files(init, manifest, registry)


class ManualWorkflowContractTest(TestCase):
    def setUp(self):
        self.workflow = (_PATH.parents[6] / ".github" / "workflows"
                         / "toolbelt-network-checker-release.yml")
        self.text = self.workflow.read_text()

    def test_release_is_manual_explicit_tag_and_draft_only(self):
        self.assertRegex(self.text, r"(?m)^\s*workflow_dispatch:\s*$")
        self.assertRegex(self.text, r"(?m)^\s+tag:\s*$")
        self.assertNotRegex(self.text, r"(?m)^\s*(push|pull_request):")
        self.assertNotIn("git tag", self.text)
        self.assertIn('gh release create "$RELEASE_TAG"', self.text)
        self.assertIn("--verify-tag", self.text)
        self.assertRegex(self.text, r"(?m)^\s+--draft\s+\\$")

    def test_release_checks_out_tag_and_verifies_version_hash_parity(self):
        self.assertIn("ref: ${{ inputs.tag }}", self.text)
        self.assertIn("persist-credentials: false", self.text)
        self.assertIn("python3 tools/release.py check", self.text)
        self.assertIn("network-checker-v${version}", self.text)

    def test_image_smoke_is_hermetic_and_permissions_are_least_privilege(self):
        self.assertNotIn('"netcheck:$version" scan', self.text)
        self.assertIn('"netcheck:$version" --help', self.text)
        self.assertRegex(self.text, r"(?m)^permissions:\n\s+contents:\s+read\s*$")
        self.assertRegex(
            self.text,
            r"(?ms)^\s{2}publish-draft:.*?^\s{4}permissions:\n\s{6}contents:\s+write\s*$",
        )
