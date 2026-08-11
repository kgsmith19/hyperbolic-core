"""Release helper contracts that keep monorepo tags application-scoped."""
import importlib.util
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
