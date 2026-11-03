"""Proves the per-app metadata validator (#450, AC1, AC3, AC6)."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_app_metadata

GOOD = ("project.yaml", "AGENTS.md", "CLAUDE.md", "README.md")


def tree(files):
    root = Path(tempfile.mkdtemp())
    (root / ".github" / "workflows").mkdir(parents=True)
    (root / ".github" / "workflows" / "pr-verify.yml").write_text("name: x\n")
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return root


def app(name, project="ci:\n  workflow: ../../.github/workflows/pr-verify.yml\n"):
    files = {f"apps/{name}/{f}": "x\n" for f in GOOD}
    files[f"apps/{name}/project.yaml"] = project
    return files


class AppMetadataTest(unittest.TestCase):
    def test_a_complete_app_passes(self):
        self.assertEqual(check_app_metadata.problems(tree(app("demo"))), [])

    def test_each_missing_file_is_reported(self):
        """Catches an app that loses its README, AGENTS.md, CLAUDE.md or project.yaml."""
        for name in GOOD:
            with self.subTest(name=name):
                files = app("demo")
                del files[f"apps/demo/{name}"]
                self.assertIn(f"apps/demo: missing {name}", check_app_metadata.problems(tree(files)))

    def test_a_ci_workflow_that_does_not_exist_is_reported(self):
        files = app("demo", "ci:\n  workflow: ../../.github/workflows/gone.yml\n")
        self.assertTrue(any("does not exist" in p for p in check_app_metadata.problems(tree(files))))

    def test_repo_root_relative_workflow_paths_are_accepted(self):
        files = app("demo", "ci:\n  workflow: .github/workflows/pr-verify.yml\n")
        self.assertEqual(check_app_metadata.problems(tree(files)), [])

    def test_a_nested_app_is_reported(self):
        """AC1: no app lives inside another app's tree."""
        files = {**app("demo"), "apps/demo/apps/inner/AGENTS.md": "x\n"}
        self.assertIn("apps/demo/apps/inner: nested app metadata inside apps/demo",
                      check_app_metadata.problems(tree(files)))

    def test_a_nested_github_dir_is_reported(self):
        """AC3: GitHub only reads the root .github/, so a nested one is dead config."""
        files = {**app("demo"), "apps/demo/.github/workflows/ci.yml": "x\n"}
        self.assertTrue(any("nested .github/" in p for p in check_app_metadata.problems(tree(files))))

    def test_the_real_tree_passes(self):
        self.assertEqual(check_app_metadata.problems(), [])


if __name__ == "__main__":
    unittest.main()
