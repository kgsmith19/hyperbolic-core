"""Finding 19 regression tests: execute()'s cwd resolution and its
process-group timeout cleanup. Real subprocesses throughout -- this finding
is entirely about what the OS actually does, so there is nothing to mock.
Split out of test_change.py/test_change_approve.py for the same
file-length-budget reason those two are already split from each other."""
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from netcheck import change


def _is_effectively_dead(pid):
    """True once `pid` is gone or a zombie. SIGKILL takes effect
    immediately, but an orphaned process can sit as a zombie for an
    indeterminate, container-dependent interval before whatever inherits it
    (init, a container subreaper) calls wait() and reaps it -- confirmed
    empirically in this sandbox (`ps` showed `Z <defunct>` for roughly a
    second after SIGKILL landed). `kill(pid, 0)` alone cannot tell a
    zombie apart from a genuinely still-running process (both succeed --
    the PID slot isn't freed until reaped), so this reads
    /proc/<pid>/stat's state field instead; Linux-only, matching
    execute()'s own POSIX-only os.killpg/start_new_session use."""
    try:
        stat_line = Path(f"/proc/{pid}/stat").read_text()
    except FileNotFoundError:
        return True
    # Field 2 (comm) is parenthesized and may itself contain spaces/parens;
    # splitting on the LAST ")" is what makes field 3 (state) safe to reach.
    return stat_line.rsplit(")", 1)[1].split()[0] == "Z"


@unittest.skipUnless(sys.platform.startswith("linux"), "relies on /proc and POSIX process groups")
class ExecuteHardeningTest(unittest.TestCase):
    def test_execute_runs_in_the_app_root_regardless_of_process_cwd(self):
        original_cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as tmp:
            os.chdir(tmp)
            try:
                rc, out, _err = change.execute("pwd")
            finally:
                os.chdir(original_cwd)
        self.assertEqual(rc, 0)
        self.assertEqual(Path(out.strip()).resolve(), change._APP_ROOT)
        self.assertNotEqual(Path(out.strip()).resolve(), Path(tmp).resolve())

    def test_a_relative_script_path_resolves_against_the_app_root(self):
        """The concrete case this matters for: change_templates.py's
        change_cmd values are script-relative ("tools/fix_dns.sh")."""
        rc, out, _err = change.execute("test -f tools/check.sh && echo present")
        self.assertEqual(rc, 0)
        self.assertEqual(out.strip(), "present")

    def test_killing_only_the_direct_pid_would_have_left_the_descendant_running(self):
        """Negative control, so the test below is a real contrast:
        reproduces the OLD code's exact cleanup
        (`subprocess.run(..., timeout=...)`, which on timeout only ever
        kills the single pid it started) against the identical
        background-child command, and shows the descendant is STILL
        RUNNING afterward -- the concrete bug Finding 19 fixes."""
        with tempfile.TemporaryDirectory() as tmp:
            pidfile = Path(tmp) / "child.pid"
            cmd = f"(sleep 5 & echo $! > {pidfile}); sleep 5"
            try:
                subprocess.run(["/bin/sh", "-c", cmd], capture_output=True,
                               text=True, timeout=1)
                self.fail("expected TimeoutExpired")
            except subprocess.TimeoutExpired:
                pass  # subprocess.run() already killed the direct /bin/sh pid here

            deadline = time.monotonic() + 2
            while not pidfile.exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            child_pid = int(pidfile.read_text().strip())
            self.assertFalse(
                _is_effectively_dead(child_pid),
                "the old single-pid kill left the backgrounded descendant "
                "running -- this is exactly what Finding 19's process-group "
                "kill fixes")
            os.kill(child_pid, signal.SIGKILL)  # clean up after the negative control

    def test_timeout_kills_the_whole_process_group_not_just_the_shell(self):
        """Proves the concrete Finding 19 guarantee: a backgrounded
        descendant of the timed-out /bin/sh does not outlive the timeout.
        Uses execute()'s test-only `timeout` override to exercise this in
        about a second instead of the real 90s budget."""
        with tempfile.TemporaryDirectory() as tmp:
            pidfile = Path(tmp) / "child.pid"
            cmd = f"(sleep 5 & echo $! > {pidfile}); sleep 5"
            start = time.monotonic()
            rc, _out, err = change.execute(cmd, timeout=1)
            elapsed = time.monotonic() - start
            self.assertEqual(rc, 124)
            self.assertIn("timed out", err)
            self.assertLess(elapsed, 5,
                            "execute() must return promptly, not wait out the "
                            "backgrounded child's own sleep")

            deadline = time.monotonic() + 2
            while not pidfile.exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertTrue(pidfile.exists(), "the backgrounded child never even started")
            child_pid = int(pidfile.read_text().strip())

            dead_deadline = time.monotonic() + 3
            while not _is_effectively_dead(child_pid) and time.monotonic() < dead_deadline:
                time.sleep(0.1)
            self.assertTrue(
                _is_effectively_dead(child_pid),
                "the backgrounded descendant of the timed-out /bin/sh must not "
                "still be running -- proves killpg reached it, not just the "
                "/bin/sh -c pid itself")


if __name__ == "__main__":
    unittest.main()
