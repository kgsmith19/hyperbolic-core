"""Security primitives re-exported by the active change lifecycle.

Execution delegates to ``change_exec``'s fixed-cwd argv allowlist; verification
delegates to ``change_verify``'s bounded probes and one monotonic retry budget.
The wrappers keep ``patch.object(change, ...)`` as the lifecycle test seam.
Approval capabilities use a separately stored owner-only HMAC key. The raw
capability is returned once; SQLite stores only its SHA-256 digest.
"""
import getpass
import hashlib
import hmac
import os
import secrets
import stat
import sys
import tempfile
from base64 import urlsafe_b64decode, urlsafe_b64encode
from datetime import datetime, timezone
from pathlib import Path

from . import change_exec, change_verify

_APP_ROOT = change_exec.APP_ROOT


def _now():
    """Shared by change.py and change_outcomes.py -- lives here (rather
    than duplicated, or imported from change.py, which would make a
    circular import with change_outcomes.py importing FROM change.py)
    because this module is the one both of those already depend on."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def execute(command, timeout=90):
    """Run one allow-listed argv operation from the application root."""
    return change_exec.execute(command, timeout=timeout)


def _run_verify(expr):
    """Measure one supported ``field:state`` expression within 30 seconds."""
    return change_verify.run(expr)


def _verify_with_retry(expr, attempts=3, budget_s=90):
    """Retry within one monotonic budget that includes probe runtime."""
    return change_verify.retry(expr, attempts=attempts, budget_s=budget_s)


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


def _read_key(path):
    if not _owner_only(path):
        raise ValueError("change key permissions are not owner-only")
    line = path.read_text().splitlines()[0].strip()
    key = urlsafe_b64decode(line.encode())
    if len(key) != 32 or urlsafe_b64encode(key).decode() != line:
        raise ValueError("invalid change key")
    return key


def _replace_key(path, key):
    """Atomically install key bytes that were never exposed above mode 0600."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        if sys.platform != "win32":
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as stream:
            fd = -1
            stream.write(urlsafe_b64encode(key).decode() + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _load_or_create_key():
    """Finding 15's real fix: `_token()` is now keyed, and this is the key.
    Mirrors agentic-command-center/gui/server.mjs's
    loadOrCreateToken()/ownerOnly() (landed precedent in this repo): one
    random 32-byte key, base64url, one line, mode 0600, minted fresh on
    first use. An EXISTING file is trusted only if its mode is still
    exactly 0600; anything else (absent, unreadable, wrong permissions,
    empty, corrupt, or not exactly 32 decoded bytes) is replaced atomically
    with a fresh owner-only key.

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
        return _read_key(path)
    except (OSError, IndexError, ValueError):
        pass  # absent, unreadable, wrong permissions, empty, or corrupt -> mint fresh
    fresh = secrets.token_bytes(32)
    _replace_key(path, fresh)
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


def _frame_part(part):
    """Encode one typed field so null, text, and integer values cannot alias."""
    if part is None:
        return b"N"
    if type(part) is int:
        return b"I" + str(part).encode()
    if type(part) is str:
        return b"S" + part.encode()
    raise TypeError("approval capability fields must be text, integers, or null")


def _frame(*parts):
    """Type-tag and length-prefix fields before concatenating."""
    out = bytearray()
    for part in parts:
        data = _frame_part(part)
        out += len(data).to_bytes(8, "big")
        out += data
    return bytes(out)


_TOKEN_FIELDS = ("id", "host_id", "device_id", "cause", "title", "change_cmd",
                 "inverse_cmd", "verify_probe")


def _token(row, approved_at, verifier):
    """Mint a capability bound to identity, commands, verifier, and evidence."""
    dry_run = row.get("dry_run_output")
    evidence = ("null" if dry_run is None else
                "sha256:" + hashlib.sha256(dry_run.encode()).hexdigest())
    material = _frame(*(row.get(field) for field in _TOKEN_FIELDS), evidence,
                      approved_at, verifier)
    return hmac.new(_load_or_create_key(), material, hashlib.sha256).hexdigest()


def _token_digest(token):
    """One-way database representation of an operator-held capability."""
    return hashlib.sha256(token.encode()).hexdigest()
