"""netcheck CLI entry point. `--version` is the one piece of __main__.py
with no coverage anywhere else -- everything else is exercised indirectly
through the modules each subcommand calls, except FR-018/NFR-009 scan routing
and hard tier budgets below."""
import argparse
import contextlib
import io
import os
import subprocess
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
            cli._cmd_scan_worker(argparse.Namespace(tier="quick", target="t"))
        mock_scan.assert_not_called()

    def test_standard_tier_calls_environ_scan_with_deep_false(self):
        with patch.object(cli, "connect", return_value=(None, "h")), \
             patch.object(cli.store, "add_scan"), \
             patch.object(cli.environ, "scan", return_value={"ts": "x"}) as mock_scan:
            cli._cmd_scan_worker(argparse.Namespace(tier="standard", target="t"))
        mock_scan.assert_called_once_with(deep=False)

    def test_deep_tier_calls_environ_scan_with_deep_true(self):
        with patch.object(cli, "connect", return_value=(None, "h")), \
             patch.object(cli.store, "add_scan"), \
             patch.object(cli.environ, "scan", return_value={"ts": "x"}) as mock_scan:
            cli._cmd_scan_worker(argparse.Namespace(tier="deep", target="t"))
        mock_scan.assert_called_once_with(deep=True)

    def test_an_unrecognized_tier_exits_before_any_probe_runs(self):
        with patch.object(cli, "connect") as mock_connect:
            with self.assertRaises(SystemExit):
                cli.main(["scan", "--tier", "bogus"])
        mock_connect.assert_not_called()


class ScanBudgetTest(unittest.TestCase):
    def _assert_tier_budget(self, tier, budget, run):
        run.reset_mock()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = cli.cmd_scan(argparse.Namespace(tier=tier, target="example.test"))
        self.assertEqual(rc, 0)
        self.assertEqual(out.getvalue(), "{}\n")
        command = run.call_args.args[0]
        kwargs = run.call_args.kwargs
        self.assertEqual(command,
                         [cli.sys.executable, "-m", "netcheck", "--target", "example.test",
                          "scan", "--tier", tier])
        self.assertEqual(kwargs["timeout"], budget)
        self.assertFalse(kwargs.get("shell", False))
        self.assertEqual(kwargs["env"][cli.SCAN_WORKER_ENV], "1")
        self.assertEqual(kwargs["env"]["NETCHECK_TARGET"], "example.test")

    def test_each_tier_runs_in_a_child_with_its_hard_budget(self):
        fake = argparse.Namespace(returncode=0, stdout="{}\n", stderr="")
        with patch.object(cli.subprocess, "run", return_value=fake) as run:
            for tier, budget in cli.SCAN_BUDGET_SECONDS.items():
                self._assert_tier_budget(tier, budget, run)

    def test_budget_timeout_exits_124_with_a_clear_message(self):
        timeout = subprocess.TimeoutExpired(["python", "-m", "netcheck"], 10)
        err = io.StringIO()
        with patch.object(cli.subprocess, "run", side_effect=timeout), \
             contextlib.redirect_stderr(err):
            rc = cli.cmd_scan(argparse.Namespace(tier="quick", target="example.test"))
        self.assertEqual(rc, 124)
        self.assertIn("quick scan exceeded 10s budget", err.getvalue())

    def test_worker_process_executes_scan_without_recursive_spawn(self):
        with patch.dict(os.environ, {cli.SCAN_WORKER_ENV: "1"}), \
             patch.object(cli, "_cmd_scan_worker", return_value=7) as worker, \
             patch.object(cli.subprocess, "run") as run:
            rc = cli.cmd_scan(argparse.Namespace(tier="quick", target="example.test"))
        self.assertEqual(rc, 7)
        worker.assert_called_once()
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
