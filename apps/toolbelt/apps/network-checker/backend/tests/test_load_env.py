"""__main__.py's `.env` reader (AGENTS.md: credentials never belong in the
repo or in argv). Split out of test_main.py to stay under that file's line
budget, the same way test_watch_args.py splits off from test_watch.py."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from network_checker import __main__ as cli


class LoadEnvTest(unittest.TestCase):
    def test_reads_pairs_strips_quotes_and_skips_comments_and_blanks(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / ".env"
            p.write_text('# comment\n\nA=plain\nB="quoted"\nC = spaced \n')
            with patch.dict(os.environ, {}, clear=False):
                for k in "ABC":
                    os.environ.pop(k, None)
                cli.load_env(p)
                self.assertEqual((os.environ["A"], os.environ["B"], os.environ["C"]),
                                 ("plain", "quoted", "spaced"))

    def test_does_not_override_an_already_set_environment_variable(self):
        """A shell-exported credential must win over a stale `.env` copy --
        `os.environ.setdefault` is the whole contract here."""
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / ".env"
            p.write_text("KEY=from_dotenv\n")
            with patch.dict(os.environ, {"KEY": "from_shell"}, clear=False):
                cli.load_env(p)
                self.assertEqual(os.environ["KEY"], "from_shell")

    def test_missing_file_is_a_no_op(self):
        with tempfile.TemporaryDirectory() as d:
            before = dict(os.environ)
            cli.load_env(Path(d) / "missing.env")
            self.assertEqual(dict(os.environ), before)


if __name__ == "__main__":
    unittest.main()
