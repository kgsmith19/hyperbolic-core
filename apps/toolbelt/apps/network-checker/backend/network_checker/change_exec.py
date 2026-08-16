"""Portable, allow-listed process execution for approved changes."""
import os
import shlex
import signal
import subprocess
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
_EXECUTABLES = {"python": sys.executable, "python3": sys.executable,
                sys.executable: sys.executable}


def _argv(command):
    parts = shlex.split(command, posix=os.name != "nt") if isinstance(command, str) else list(command)
    if not parts or parts[0] not in _EXECUTABLES:
        raise ValueError("change command is not allow-listed")
    parts[0] = _EXECUTABLES[parts[0]]
    if parts[1:3] != ["-m", "network_checker"] or parts[3:] != ["--version"]:
        raise ValueError("only the non-mutating network-checker version operation is enabled")
    return parts


def _text(value):
    return value.decode(errors="replace") if isinstance(value, bytes) else value or ""


def _stop_tree(proc):
    if os.name == "nt":
        result = subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                                capture_output=True, timeout=10)
        if result.returncode:
            proc.kill()
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass  # the group exited between the timeout and termination attempt


def execute(command, timeout=90):
    """Run allow-listed argv from a fixed cwd; timeouts reap the process tree."""
    kwargs = {"cwd": APP_ROOT, "stdout": subprocess.PIPE, "stderr": subprocess.PIPE,
              "text": True}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    proc = subprocess.Popen(_argv(command), **kwargs)
    try:
        out, err = proc.communicate(timeout=timeout)
        return proc.returncode, out, err
    except subprocess.TimeoutExpired as exc:
        _stop_tree(proc)
        try:
            out, err = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, err = proc.communicate(timeout=5)
        message = (_text(err) or _text(exc.stderr)) + "\n[change] timed out"
        return 124, _text(out) or _text(exc.stdout), message
