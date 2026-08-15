"""Active change executor and verification deadline security tests."""
import argparse
import os
import subprocess
import sys
import unittest
from unittest.mock import patch

from netcheck import change, change_exec, change_verify


class _Process:
    def __init__(self, completed=None, timeout=False, timeout_output=None):
        self.returncode = completed.returncode if completed else 0
        self.out = completed.stdout if completed else ""
        self.err = completed.stderr if completed else ""
        self.timeout = timeout
        self.timeout_output = timeout_output
        self.pid = 4321
        self.communicate_calls = 0

    def communicate(self, timeout=None):
        self.communicate_calls += 1
        if self.timeout and self.communicate_calls == 1:
            stdout, stderr = self.timeout_output or (None, None)
            raise subprocess.TimeoutExpired(["python"], timeout, output=stdout, stderr=stderr)
        return self.out, self.err

    def kill(self):
        pass


class ExecuteHardeningTest(unittest.TestCase):
    def test_allowed_argv_runs_without_a_shell_from_the_application_root(self):
        completed = argparse.Namespace(returncode=0, stdout="ok", stderr="")
        with patch.object(change_exec.subprocess, "Popen",
                          return_value=_Process(completed)) as popen:
            self.assertEqual(change.execute(["python", "-m", "netcheck", "--version"]),
                             (0, "ok", ""))
        argv = popen.call_args.args[0]
        self.assertEqual(argv[0], sys.executable)
        self.assertEqual(argv[1:], ["-m", "netcheck", "--version"])
        self.assertEqual(popen.call_args.kwargs["cwd"], change._APP_ROOT)
        self.assertNotIn("shell", popen.call_args.kwargs)

    def test_shell_interpreters_and_arbitrary_binaries_are_refused(self):
        with patch.object(change_exec.subprocess, "Popen", return_value=_Process()) as popen:
            for command in (["bash", "-c", "echo unsafe"], ["rm", "-rf", "/"],
                            "test -f tools/check.sh",
                            "python -m netcheck --version; rm -rf /"):
                with self.subTest(command=command), self.assertRaises(ValueError):
                    change.execute(command)
        popen.assert_not_called()

    @unittest.skipIf(os.name == "nt", "POSIX process-group assertion")
    def test_timeout_kills_the_process_group_and_waits(self):
        proc = _Process(timeout=True)
        with patch.object(change_exec.subprocess, "Popen", return_value=proc), \
             patch.object(change_exec.os, "killpg") as killpg:
            rc, _out, err = change.execute(
                ["python", "-m", "netcheck", "--version"], timeout=0.01)
        self.assertEqual(rc, 124)
        self.assertIn("timed out", err)
        killpg.assert_called_once_with(proc.pid, change_exec.signal.SIGKILL)
        self.assertEqual(proc.communicate_calls, 2)

    @unittest.skipIf(os.name == "nt", "POSIX process-group assertion")
    def test_timeout_tolerates_a_process_group_that_already_exited(self):
        proc = _Process(timeout=True)
        with patch.object(change_exec.subprocess, "Popen", return_value=proc), \
             patch.object(change_exec.os, "killpg", side_effect=ProcessLookupError):
            rc, _out, err = change.execute(
                ["python", "-m", "netcheck", "--version"], timeout=0.01)
        self.assertEqual(rc, 124)
        self.assertIn("timed out", err)
        self.assertEqual(proc.communicate_calls, 2)

    def test_timeout_normalizes_partial_byte_output_after_reaping(self):
        proc = _Process(timeout=True, timeout_output=(b"partial-out", b"partial-err"))
        with patch.object(change_exec.subprocess, "Popen", return_value=proc), \
             patch.object(change_exec, "_stop_tree"):
            rc, out, err = change.execute(
                ["python", "-m", "netcheck", "--version"], timeout=0.01)
        self.assertEqual((rc, out), (124, "partial-out"))
        self.assertIn("partial-err", err)
        self.assertIn("timed out", err)
        self.assertIsInstance(out, str)
        self.assertIsInstance(err, str)


class VerificationDeadlineTest(unittest.TestCase):
    def test_probe_runtime_shares_one_ninety_second_budget(self):
        elapsed = [0.0]

        def bounded_probe(_expr, timeout):
            elapsed[0] += min(timeout, 20)
            return False, {"field": "dns_public", "want": "ok", "got": "fail"}

        with patch.object(change_verify, "run", side_effect=bounded_probe), \
             patch.object(change_verify.time, "monotonic", side_effect=lambda: elapsed[0]):
            change._verify_with_retry("dns_public:ok", attempts=5, budget_s=90)
        self.assertLessEqual(elapsed[0], 90)


if __name__ == "__main__":
    unittest.main()
