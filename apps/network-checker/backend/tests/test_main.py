"""network-checker CLI entry point. `--version` is the one piece of __main__.py
with no coverage anywhere else -- everything else is exercised indirectly
through the modules each subcommand calls, except FR-018/NFR-009 scan routing
and hard tier budgets below."""
import argparse
import contextlib
import io
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import network_checker
from network_checker import __main__ as cli


class VersionFlagTest(unittest.TestCase):
    def test_version_flag_prints_version_and_exits_zero(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            with self.assertRaises(SystemExit) as cm:
                cli.main(["--version"])
        self.assertEqual(cm.exception.code, 0)
        self.assertIn(network_checker.__version__, out.getvalue())

    def test_dunder_version_is_a_dotted_string(self):
        self.assertRegex(network_checker.__version__, r"^\d+\.\d+\.\d+$")


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
             patch.object(cli.inventory, "record_inventory") as mock_inventory, \
             patch.object(cli.environ, "scan", return_value={"ts": "x"}) as mock_scan:
            cli._cmd_scan_worker(argparse.Namespace(tier="standard", target="t"))
        mock_scan.assert_called_once_with(deep=False)
        mock_inventory.assert_called_once_with(None, "h", {"ts": "x"}, "x")

    def test_deep_tier_calls_environ_scan_with_deep_true(self):
        with patch.object(cli, "connect", return_value=(None, "h")), \
             patch.object(cli.store, "add_scan"), \
             patch.object(cli.inventory, "record_inventory") as mock_inventory, \
             patch.object(cli.environ, "scan", return_value={"ts": "x"}) as mock_scan:
            cli._cmd_scan_worker(argparse.Namespace(tier="deep", target="t"))
        mock_scan.assert_called_once_with(deep=True)
        mock_inventory.assert_called_once_with(None, "h", {"ts": "x"}, "x")

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
                         [cli.sys.executable, "-m", "network_checker", "--target", "example.test",
                          "scan", "--tier", tier])
        self.assertEqual(kwargs["timeout"], budget)
        self.assertFalse(kwargs.get("shell", False))
        self.assertEqual(kwargs["env"][cli.SCAN_WORKER_ENV], "1")
        self.assertEqual(kwargs["env"]["NETWORK_CHECKER_TARGET"], "example.test")

    def test_each_tier_runs_in_a_child_with_its_hard_budget(self):
        fake = argparse.Namespace(returncode=0, stdout="{}\n", stderr="")
        with patch.object(cli.subprocess, "run", return_value=fake) as run:
            for tier, budget in cli.SCAN_BUDGET_SECONDS.items():
                self._assert_tier_budget(tier, budget, run)

    def test_budget_timeout_exits_124_with_a_clear_message(self):
        timeout = subprocess.TimeoutExpired(["python", "-m", "network_checker"], 10)
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


class NFR009BudgetConstantsTest(unittest.TestCase):
    """The documented scan budgets are pinned as executable product behavior."""

    def test_scan_budgets_match_documented_contract(self):
        self.assertEqual(cli.SCAN_BUDGET_SECONDS,
                         {"quick": 10, "standard": 60, "deep": 120})


class ScanBudgetBoundaryTest(unittest.TestCase):
    """NFR-009: prove the coordination and timeout logic in `cmd_scan` -- the
    thing that actually enforces quick<=10s, standard<=60s, deep<=120s --
    holds at the boundary, deterministically and without a real sleep.

    `subprocess.run(..., timeout=T)` is documented to raise
    `TimeoutExpired` once the child has run for `T` seconds without
    finishing. A fake `subprocess.run` that decides which branch to take
    from an injected `duration` -- never actually sleeping -- lets a test
    walk that boundary for every tier: strictly under budget (succeeds),
    exactly at budget (still within the contract, succeeds), and over
    budget (the real subprocess would still be running, so it must be
    killed and reported as 124). This is the fake probe-timing injection
    NFR-006 requires in place of a live, flaky wall-clock measurement.
    """

    @staticmethod
    def _fake_run(duration):
        """Stand-in for `subprocess.run`, modelling its own documented
        timeout contract from an injected elapsed `duration` instead of an
        actual clock."""
        def run(command, **kwargs):
            timeout = kwargs["timeout"]
            if duration > timeout:
                raise subprocess.TimeoutExpired(command, timeout)
            return argparse.Namespace(returncode=0, stdout="{}\n", stderr="")
        return run

    def _assert_case(self, tier, budget, duration, expect_timeout):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(cli.subprocess, "run", self._fake_run(duration)), \
             contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cli.cmd_scan(argparse.Namespace(tier=tier, target="example.test"))
        if not expect_timeout:
            self.assertEqual((rc, out.getvalue(), err.getvalue()), (0, "{}\n", ""))
            return
        self.assertEqual(rc, 124)
        self.assertIn(f"{tier} scan exceeded {budget}s budget", err.getvalue())

    def test_boundary_cases_for_every_tier(self):
        for tier, budget in cli.SCAN_BUDGET_SECONDS.items():
            cases = {
                "under_budget": (budget - 1, False),
                "at_budget": (budget, False),
                "over_budget": (budget + 1, True),
            }
            for case_name, (duration, expect_timeout) in cases.items():
                with self.subTest(tier=tier, case=case_name, duration=duration):
                    self._assert_case(tier, budget, duration, expect_timeout)


class WatchTimingValidationTest(unittest.TestCase):
    """Finding 64 (independent security review): --interval/--idle-every
    must be rejected at argument-parsing time when <= 0, before watch.run()
    (and its ZeroDivisionError-prone `tick % args.idle_every`) ever starts."""

    def _assert_rejected_before_connect(self, argv):
        with patch.object(cli, "connect") as mock_connect, \
             contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as cm:
                cli.main(argv)
        self.assertNotEqual(cm.exception.code, 0)
        mock_connect.assert_not_called()

    def test_idle_every_zero_is_rejected(self):
        self._assert_rejected_before_connect(["watch", "--idle-every", "0"])

    def test_idle_every_negative_is_rejected(self):
        self._assert_rejected_before_connect(["watch", "--idle-every", "-1"])

    def test_interval_zero_is_rejected(self):
        self._assert_rejected_before_connect(["watch", "--interval", "0"])

    def test_interval_negative_is_rejected(self):
        self._assert_rejected_before_connect(["watch", "--interval", "-5"])

    def test_a_positive_interval_and_idle_every_are_accepted(self):
        """Positive control: the validator itself, not just argparse
        wiring, is what's under test -- a legitimate value must still
        parse (as a real int, not swallowed by an over-eager mock) and
        reach cmd_watch. Only `watch.run` is patched -- `watch._positive_int`
        itself must stay real, since argparse calls it while building the
        parser inside `cli.main()`."""
        with patch.object(cli, "connect", return_value=(None, "h")), \
             patch.object(cli.watch, "run", return_value=0) as run:
            rc = cli.main(["watch", "--interval", "5", "--idle-every", "2"])
        self.assertEqual(rc, 0)
        args = run.call_args.args[1]
        self.assertEqual((args.interval, args.idle_every), (5, 2))


class ExportCliTest(unittest.TestCase):
    """FR-074: `network-checker export` writes one redacted artifact and never
    touches the network or mutates the store to produce it."""

    def _run(self, tmp_path, fmt="markdown"):
        out_path = tmp_path / f"bundle.{'json' if fmt == 'json' else 'md'}"
        with patch.object(cli, "connect", return_value=(None, "h")), \
             patch.object(cli.store, "samples", return_value=[]), \
             patch.object(cli.store, "errors", return_value=[]), \
             patch.object(cli.store, "scans", return_value=[]), \
             patch.object(cli.llmlog, "ingest") as ingest, \
             patch("urllib.request.urlopen",
                  side_effect=AssertionError("no network call allowed")):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = cli.cmd_export(argparse.Namespace(format=fmt, out=out_path))
        return rc, out.getvalue(), ingest

    def test_writes_the_requested_format_and_prints_its_path(self):
        with tempfile.TemporaryDirectory() as d:
            rc, printed, ingest = self._run(Path(d), fmt="json")
            out_path = Path(d) / "bundle.json"
            self.assertEqual(rc, 0)
            self.assertIn(str(out_path), printed)
            self.assertTrue(out_path.exists())
            ingest.assert_not_called()

    def test_never_reads_or_writes_the_database(self):
        with tempfile.TemporaryDirectory() as d:
            with patch.object(cli.store, "add_sample") as add_sample, \
                 patch.object(cli.store, "add_error") as add_error:
                self._run(Path(d))
            add_sample.assert_not_called()
            add_error.assert_not_called()


if __name__ == "__main__":
    unittest.main()
