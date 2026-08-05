"""netcheck CLI entry point. `--version` is the one piece of __main__.py
with no coverage anywhere else -- everything else is exercised indirectly
through the modules each subcommand calls."""
import contextlib
import io
import unittest

import netcheck
from netcheck import __main__ as cli


class VersionFlagTest(unittest.TestCase):
    def test_version_flag_prints_version_and_exits_zero(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            with self.assertRaises(SystemExit) as cm:
                cli.main(["--version"])
        self.assertEqual(cm.exception.code, 0)
        self.assertIn(netcheck.__version__, out.getvalue())

    def test_dunder_version_is_a_dotted_string(self):
        self.assertRegex(netcheck.__version__, r"^\d+\.\d+\.\d+$")


if __name__ == "__main__":
    unittest.main()
