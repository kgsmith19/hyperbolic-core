"""Security-relevant primitives for the change lifecycle engine
(change.py): real subprocess execution, live probe verification, and the
keyed approval-token machinery (Findings 15/19, independent security
review, re-verified against current HEAD). Split out purely to keep
change.py's own line budget under the repo's medium-profile 250-line
ceiling (`tools/check.sh`'s file_too_long check) once Findings 15/16/17/19
were all implemented there together -- the same reason change_cli.py was
already split out for CLI presentation. No behavior moved with it: every
function here is re-exported into change.py via `from .change_security
import ...`, so `unittest.mock.patch.object(change, "execute", fake)` (and
the same pattern for `_run_verify`/`_verify_with_retry`) still intercepts
calls made from change.py's own lifecycle functions -- Python resolves a
bare name at call time from the calling module's own namespace, which the
patch target and the re-exported binding are the same object.

`execute()` is the one seam touching a real subprocess -- change_cmd and
inverse_cmd both pass through it and only it. `_run_verify`/
`_verify_with_retry` are the other real seam (route_mod.*, probes.sample,
environ.wifi).

Finding 15: `_token()` is a keyed HMAC (`_load_or_create_key()`, `_frame()`)
over a length-framed field list that also binds `approved_by`, not the old
unkeyed sha256 over a delimiter-free concatenation. Finding 19: `execute()`
runs with an explicit `cwd` and its own process group, killed whole (not
just its direct child) on timeout.
"""
import getpass
import hashlib
import hmac
import os
import secrets
import signal
import stat
import subprocess
import sys
import time
from base64 import urlsafe_b64decode, urlsafe_b64encode
from datetime import datetime, timezone
from pathlib import Path

from . import environ, probes
from . import route as route_mod

# This app's root (change_security.py lives at <root>/netcheck/change_security.py)
# -- execute()'s cwd (Finding 19), so change_templates.py's script-relative
# commands (e.g. "tools/fix_dns.sh") resolve the same regardless of the
# caller's own cwd.
_APP_ROOT = Path(__file__).resolve().parent.parent


def _now():
    """Shared by change.py and change_outcomes.py -- lives here (rather
    than duplicated, or imported from change.py, which would make a
    circular import with change_outcomes.py importing FROM change.py)
    because this module is the one both of those already depend on."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def execute(cmd, timeout=90):
    """Run one shell command for real. Argv-shaped `["/bin/sh", "-c", cmd]`
    rather than `shell=True` -- textually different, identically
    injection-capable; not a safety property. The real authorization
    boundary is upstream, in apply()'s HMAC check and atomic claim
    (Findings 15/16, change.py). (An earlier docstring here claimed this
    argv form dodges tools/security_review.py's `shell=True` pattern
    match -- true, and a real, still-open scanner gap, but never a safety
    property; corrected rather than left standing.)

    Finding 19: `cwd=_APP_ROOT` so script-relative commands resolve the
    same regardless of the caller's own cwd; `start_new_session=True` +
    `os.killpg(...)` on timeout kills this /bin/sh's whole process group,
    not just its own pid, so a pipeline's descendants can't outlive the
    budget -- Popen, not `run(timeout=)`, because `run()` never exposes the
    process object a caller would need to killpg. `timeout` defaults to the
    real 90s budget; a test can shorten it to exercise the timeout path fast.
    """
    proc = subprocess.Popen(
        ["/bin/sh", "-c", cmd], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, cwd=_APP_ROOT, start_new_session=True)
    try:
        out, err = proc.communicate(timeout=timeout)
        return proc.returncode, out, err
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass  # the group leader (or the whole group) already exited
        out, err = proc.communicate()  # reap; collect whatever was buffered
        return 124, out or "", (err or "") + "\n[change] timed out"


def _run_verify(expr):
    """Parse a `field:state` probe expression (e.g. `dns_public:ok`) and
    measure it for real. The only place this module calls probes.sample."""
    field, _, want = expr.partition(":")
    gw = route_mod.gateway()
    row = probes.sample(environ.TARGET, gw, route_mod.first_hop(gateway_ip=gw),
                        wifi=environ.wifi())
    got = row.get(f"{field}_state")
    return got == want, {"field": field, "want": want, "got": got}


def _verify_with_retry(expr, attempts=3, budget_s=90):
    """05-f section 4.4: up to 3 attempts over at most `budget_s` seconds --
    a real wall-clock deadline (Finding 59, independent security review).

    The old formula slept a fixed `budget_s/attempts` between every
    attempt with no accounting for how long each probe itself took, so
    total wall time was `attempts*probe_duration + (attempts-1)*(budget_s/
    attempts)` -- uncapped by anything, and routinely well past the
    90-second budget this function promises its caller (change.py's
    apply()/_rollback(), which themselves have no outer timeout of their
    own). Fixed: `deadline` is computed once at entry from the real clock,
    and every sleep is `min(remaining_time, budget_s/attempts)` -- never
    more than the even per-attempt share, but shorter once a slow probe has
    already eaten into the budget. Once the deadline has passed, this stops
    retrying and returns the last result even with attempts left unused,
    rather than sleeping (or probing) further past what was promised."""
    log = []
    deadline = time.monotonic() + budget_s
    per_attempt = budget_s / attempts
    for i in range(attempts):
        ok, detail = _run_verify(expr)
        log.append({"attempt": i + 1, "ok": ok, **detail})
        if ok:
            return True, log
        if i >= attempts - 1:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(remaining, per_attempt))
    return False, log


def _key_file():
    """NETCHECK_CHANGE_KEY_FILE overrides the path (same convention
    NETCHECK_DB uses in __main__.py). Default is deliberately NOT under
    ~/.netcheck/ (NETCHECK_DB's own directory), so the key shares neither a
    directory nor a trust boundary with the file it protects."""
    return Path(os.environ.get(
        "NETCHECK_CHANGE_KEY_FILE", str(Path.home() / ".netcheck-change-key")))


def _owner_only(path):
    # No POSIX owner/group/other semantics on Windows (same guard as
    # agentic-command-center/gui/server.mjs's ownerOnly) -- nothing to
    # enforce there, so every existing file is trusted.
    return sys.platform == "win32" or stat.S_IMODE(path.stat().st_mode) == 0o600


def _load_or_create_key():
    """Finding 15's real fix: `_token()` is now keyed, and this is the key.
    Mirrors agentic-command-center/gui/server.mjs's
    loadOrCreateToken()/ownerOnly() (landed precedent in this repo): one
    random 32-byte key, base64url, one line, mode 0600, minted fresh on
    first use. An EXISTING file is trusted only if its mode is still
    exactly 0600; anything else (absent, unreadable, wrong permissions,
    empty, corrupt) is "no key yet" -> mint fresh and rewrite with the
    correct mode -- otherwise a same-user process could pre-plant a
    world-readable key with an attacker-known value and have it trusted.

    Honest threat model, exactly server.mjs's: mode 0600 keeps a DIFFERENT
    OS account out, not another process running as the SAME account, which
    can already read the SQLite DB this closes Finding 15 against (an
    unkeyed sha256 anyone with DB access could recompute, no secret at
    all). Not cached at module scope: every `netcheck change ...`
    invocation is already its own fresh process, so a per-call re-read
    keeps NETCHECK_CHANGE_KEY_FILE a live per-test seam like NETCHECK_DB.
    """
    path = _key_file()
    try:
        if not _owner_only(path):
            raise ValueError("netcheck change key file has looser-than-owner-only "
                             "permissions; refusing to trust it")
        line = path.read_text().splitlines()[0].strip()
        if line:
            return urlsafe_b64decode(line.encode())
    except (OSError, IndexError, ValueError):
        pass  # absent, unreadable, wrong permissions, empty, or corrupt -> mint fresh
    fresh = secrets.token_bytes(32)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(urlsafe_b64encode(fresh).decode() + "\n")
    # Belt-and-braces: write_text's mode follows the platform umask, not
    # necessarily 0600, and an existing wrong-mode file (the case above
    # exists to correct) keeps its old mode unless reset here explicitly.
    if sys.platform != "win32":
        os.chmod(path, 0o600)
    return fresh


def _current_user():
    """Best-effort OS username for `approved_by` (Finding 15c) -- an audit
    trail of who ran approve(), not a security boundary by itself (any
    same-user process could report any string here, same as it once could
    forge the unkeyed token). getpass.getuser() can raise with no
    resolvable user database entry -- caught rather than crash approve()."""
    try:
        return getpass.getuser()
    except Exception:
        return "unknown"


def _frame(*parts):
    """Length-prefix each field before concatenating (Finding 15's second,
    independent bug): a delimiter-free join like the old formula's lets two
    different field splits hash identically (change_cmd="ab"+inverse_cmd="c"
    joins the same as change_cmd="a"+inverse_cmd="bc"). An 8-byte
    big-endian length ahead of each part removes that ambiguity regardless
    of what bytes the part itself contains."""
    out = bytearray()
    for part in parts:
        data = str(part).encode()
        out += len(data).to_bytes(8, "big")
        out += data
    return bytes(out)


def _token(row, approved_at, verifier):
    """Keyed HMAC-SHA256 hex (Finding 15) over a length-framed (id,
    change_cmd, inverse_cmd, sha256(dry_run_output), approved_at, verifier).
    Recomputed from whatever the row *currently* holds, never read off the
    frozen `approval_token` column, so a post-approval edit to any of those
    fields (now including `approved_by`) invalidates the issued token
    (NC-4.3). `approved_at`/`verifier` are explicit arguments, not read
    from `row`, because at mint time (approve(), change.py) neither is in
    the row yet."""
    evidence = hashlib.sha256((row["dry_run_output"] or "").encode()).hexdigest()
    material = _frame(row["id"], row["change_cmd"], row["inverse_cmd"], evidence,
                      approved_at, verifier or "")
    return hmac.new(_load_or_create_key(), material, hashlib.sha256).hexdigest()
