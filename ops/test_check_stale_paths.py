"""Proves the stale-path guard catches the old toolbelt layout (#450, AC4 mutation proof)."""

import io
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_stale_paths


def repo_with(files):
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
    return root


def run(root):
    with redirect_stdout(io.StringIO()) as out, redirect_stderr(io.StringIO()):
        code = check_stale_paths.main(root)
    return code, out.getvalue()


class StalePathGuardTest(unittest.TestCase):
    def test_a_planted_stale_path_fails_the_guard(self):
        """Mutation proof: pointing a live file at the old location must fail."""
        root = repo_with({"apps/shell/src/config.ts": "const p = 'apps/toolbelt/apps/idea-intake';\n"})
        code, out = run(root)
        self.assertEqual(code, 1)
        self.assertIn("apps/shell/src/config.ts:1", out)

    def test_both_old_spellings_are_caught(self):
        root = repo_with({"README.md": "cd toolbelt/apps/network-checker\n"})
        self.assertEqual(run(root)[0], 1)

    def test_history_is_allowed(self):
        """Archived docs and applied migrations keep their original text."""
        root = repo_with({
            "docs/archived/old.md": "apps/toolbelt\n",
            "supabase/migrations/2026_x.sql": "-- apps/toolbelt/supabase\n",
            "apps/idea-intake/backend/supabase/migrations/2026_y.sql": "-- apps/toolbelt\n",
        })
        self.assertEqual(run(root)[0], 0)

    def test_untracked_files_are_ignored(self):
        root = repo_with({"ok.md": "fine\n"})
        (root / "scratch.md").write_text("apps/toolbelt\n")
        self.assertEqual(run(root)[0], 0)

    def test_the_real_tree_is_clean(self):
        """The repository itself has no stale reference outside the allowed history."""
        self.assertEqual(run(check_stale_paths.ROOT)[0], 0)


if __name__ == "__main__":
    unittest.main()
