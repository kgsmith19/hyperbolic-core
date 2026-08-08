"""netcheck CLI entry point. `--version` is the one piece of __main__.py
with no coverage anywhere else -- everything else is exercised indirectly
through the modules each subcommand calls, except FR-018's --tier routing
below, which is what could silently break without being caught there."""
import argparse
import contextlib
import io
import unittest
from unittest.mock import patch

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


class ScanTierCliTest(unittest.TestCase):
    def test_quick_tier_never_calls_environ_scan(self):
        with patch.object(cli, "connect", return_value=(None, "h")), \
             patch.object(cli, "_one_probe_row", return_value={"ts": "x", "culprit": None}), \
             patch.object(cli.store, "add_sample"), \
             patch.object(cli.environ, "scan") as mock_scan:
            cli.cmd_scan(argparse.Namespace(tier="quick", target="t"))
        mock_scan.assert_not_called()

    def test_standard_tier_calls_environ_scan_with_deep_false(self):
        with patch.object(cli, "connect", return_value=(None, "h")), \
             patch.object(cli.store, "add_scan"), \
             patch.object(cli.environ, "scan", return_value={"ts": "x"}) as mock_scan:
            cli.cmd_scan(argparse.Namespace(tier="standard", target="t"))
        mock_scan.assert_called_once_with(deep=False)

    def test_deep_tier_calls_environ_scan_with_deep_true(self):
        with patch.object(cli, "connect", return_value=(None, "h")), \
             patch.object(cli.store, "add_scan"), \
             patch.object(cli.environ, "scan", return_value={"ts": "x"}) as mock_scan:
            cli.cmd_scan(argparse.Namespace(tier="deep", target="t"))
        mock_scan.assert_called_once_with(deep=True)

    def test_an_unrecognized_tier_exits_before_any_probe_runs(self):
        with patch.object(cli, "connect") as mock_connect:
            with self.assertRaises(SystemExit):
                cli.main(["scan", "--tier", "bogus"])
        mock_connect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
