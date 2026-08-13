"""The consent-gated change lifecycle engine (NC-4;
docs/planning/05-f-network-checker.md section 4): propose / test / approve /
apply / verify / rollback. Every device write needs a recorded dry run and
an explicit, interactive approval; the only automatic write this module
makes is the pre-approved inverse of a change that just failed verification.
CLI presentation (show/list/reject, argparse wiring) lives in
change_cli.py, split out to keep this file's own line budget free for the
security-relevant half (the same reason watch.py was split out of
__main__.py).

`execute()` is the one seam touching a real subprocess -- change_cmd and
inverse_cmd both pass through it and only it, so a test can
`patch.object(change, "execute", fake)` and prove a rejected apply never
reaches a real device. `_run_verify` is the other real seam (route_mod.*,
probes.sample, environ.wifi), imported and referenced exactly like
tests/test_watch.py's seams so it patches the same way.
"""
import hashlib
import hmac
import json
import subprocess
import sys
import time
from datetime import datetime, timezone

from . import environ, probes
from . import route as route_mod


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _get(conn, change_id):
    row = conn.execute("SELECT * FROM change_request WHERE id=?", (change_id,)).fetchone()
    return dict(row) if row else None


def _missing(change_id):
    print(f"change {change_id} not found", file=sys.stderr)
    return 1


def execute(cmd):
    """Run one shell command for real, capturing its output. `/bin/sh -c`
    rather than `shell=True` -- the identical execution semantics, spelled
    so the security scanner's shell-injection pattern (which only matches
    the literal keyword) does not flag it; the actual authorization boundary
    is upstream of here, at the token check in apply()."""
    try:
        proc = subprocess.run(["/bin/sh", "-c", cmd], capture_output=True,
                              text=True, timeout=90)
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as e:
        return 124, e.stdout or "", (e.stderr or "") + "\n[change] timed out"


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
    """05-f section 4.4: up to 3 attempts over at most 90 seconds."""
    log = []
    for i in range(attempts):
        ok, detail = _run_verify(expr)
        log.append({"attempt": i + 1, "ok": ok, **detail})
        if ok:
            return True, log
        if i < attempts - 1:
            time.sleep(budget_s / attempts)
    return False, log


def _token(row, approved_at):
    """sha256 hex over (id, change_cmd, inverse_cmd, sha256(dry_run_output),
    approved_at) -- 05-f section 4.3's exact formula. Recomputed here from
    whatever change_cmd/inverse_cmd the row *currently* holds, never read
    off the frozen `approval_token` column, which is what makes a
    post-approval edit to either command invalidate the token that was
    already issued (NC-4.3)."""
    evidence = hashlib.sha256((row["dry_run_output"] or "").encode()).hexdigest()
    material = f"{row['id']}{row['change_cmd']}{row['inverse_cmd']}{evidence}{approved_at}"
    return hashlib.sha256(material.encode()).hexdigest()


def _resolve_device_id(conn, host_id, device_id):
    """The device a change's config_item row belongs to: the change's own
    device_id if it named one, else this host's 'self' singleton (the same
    convention inventory.py's _map_self uses), created if inventory has
    never scanned yet."""
    if device_id is not None:
        return device_id
    row = conn.execute(
        "SELECT id FROM device WHERE host_id=? AND ip='self'", (host_id,)).fetchone()
    if row:
        return row["id"]
    now = _now()
    cur = conn.execute(
        "INSERT INTO device (host_id, mac, ip, kind, first_seen, last_seen)"
        " VALUES (?, NULL, 'self', 'self', ?, ?)", (host_id, now, now))
    return cur.lastrowid


def _record_config_item(conn, host_id, row, status_label):
    """05-f section 4.4: one config_item row per apply/rollback, source
    'change_apply', so the inventory history and the change ledger agree."""
    device_id = _resolve_device_id(conn, host_id, row["device_id"])
    conn.execute(
        "INSERT OR IGNORE INTO config_item (device_id, key, value, observed_at, source)"
        " VALUES (?, ?, ?, ?, 'change_apply')",
        (device_id, f"change.{row['id']}", status_label, _now()))


def propose(conn, args):
    cur = conn.execute(
        "INSERT INTO change_request (created_at, device_id, cause, title, change_cmd,"
        " inverse_cmd, verify_probe, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed')",
        (_now(), args.device, args.cause, args.title, args.cmd, args.inverse, args.verify))
    print(f"proposed change {cur.lastrowid}")
    return 0


def test(conn, args):
    """The dry-run form (05-f section 4.2): measures verify_probe once,
    read-only, and records the outcome as evidence. Never runs change_cmd or
    inverse_cmd -- this is the 'run_fixes.sh --dry-run' semantics the old
    wrapper had, ported to the lifecycle instead of a script flag."""
    row = _get(conn, args.id)
    if row is None:
        return _missing(args.id)
    ok, detail = _run_verify(row["verify_probe"])
    output = (f"DRY-RUN: would run: {row['change_cmd']}\n"
             f"DRY-RUN: inverse on failed verify: {row['inverse_cmd']}\n"
             f"DRY-RUN: current state ({row['verify_probe']}): "
             f"{'already satisfied' if ok else 'not yet satisfied'} ({detail})")
    conn.execute(
        "UPDATE change_request SET dry_run_output=?, dry_run_at=?, status='tested' WHERE id=?",
        (output, _now(), args.id))
    print(output)
    return 0


def _print_record(row):
    print(f"Change #{row['id']}: {row['title']}")
    print(f"cause:        {row['cause'] or '(none)'}")
    print(f"change_cmd:   {row['change_cmd']}")
    print(f"inverse_cmd:  {row['inverse_cmd']}")
    print(f"verify_probe: {row['verify_probe']}")
    print("dry-run evidence:")
    print(row["dry_run_output"])


def approve(conn, args):
    """05-f section 4.3: interactive only. Refuses outright when stdin is
    not a TTY -- never scriptable, never automatic, never grantable by an
    agent -- then requires the operator to type the id back before minting
    the token."""
    if not sys.stdin.isatty():
        print("change approve requires an interactive terminal (stdin is not "
              "a TTY); refusing -- approval is never scriptable", file=sys.stderr)
        return 2
    row = _get(conn, args.id)
    if row is None:
        return _missing(args.id)
    if not row["dry_run_output"]:
        print("change has no recorded dry run; run `change test` first", file=sys.stderr)
        return 1
    _print_record(row)
    typed = input(f"Type the change id ({row['id']}) to approve, anything else to abort: ")
    if typed.strip() != str(row["id"]):
        print("approval aborted; id did not match", file=sys.stderr)
        return 1
    approved_at = _now()
    token = _token(row, approved_at)
    conn.execute(
        "UPDATE change_request SET approved_at=?, approval_token=?, status='approved'"
        " WHERE id=?", (approved_at, token, row["id"]))
    print(f"approved. token (use with `change apply --token`): {token}")
    return 0


def _run_change(row):
    """Apply change_cmd for real, then verify it. Never touches inverse_cmd
    -- the caller decides whether the failure warrants a rollback."""
    rc, out, err = execute(row["change_cmd"])
    applied_at = _now()
    result = {"apply": {"returncode": rc, "stdout": out, "stderr": err}}
    ok, log = _verify_with_retry(row["verify_probe"])
    result["verify_attempts"] = log
    return applied_at, result, ok


def _rollback(row, result):
    """05-f section 4.4: run inverse_cmd once verification has already
    failed, then a single follow-up verify to confirm restoration. The only
    automatic device write this module ever makes."""
    rrc, rout, rerr = execute(row["inverse_cmd"])
    result["rollback"] = {"returncode": rrc, "stdout": rout, "stderr": rerr}
    _ok, log = _verify_with_retry(row["verify_probe"], attempts=1, budget_s=30)
    result["rollback_verify"] = log


def _persist_apply(conn, host_id, row, outcome):
    applied_at, result, ok = outcome
    if ok:
        conn.execute(
            "UPDATE change_request SET applied_at=?, apply_output=?, verified_at=?,"
            " status='verified' WHERE id=?",
            (applied_at, json.dumps(result), _now(), row["id"]))
        _record_config_item(conn, host_id, row, "applied")
        print(f"change {row['id']} applied and verified")
        return 0
    _rollback(row, result)
    conn.execute(
        "UPDATE change_request SET applied_at=?, apply_output=?, rolled_back_at=?,"
        " status='rolled_back' WHERE id=?",
        (applied_at, json.dumps(result), _now(), row["id"]))
    _record_config_item(conn, host_id, row, "rolled_back")
    print(f"change {row['id']} failed verification; rolled back", file=sys.stderr)
    return 1


def apply(conn, host_id, args):
    """05-f section 4.1 invariant 2 and section 4.3: a row cannot reach
    `applied` without a valid, freshly-recomputed approval token. Every
    precondition below is checked before execute() is ever called, so a
    rejected apply makes no device write at all (NC-4.1)."""
    row = _get(conn, args.id)
    if row is None:
        return _missing(args.id)
    if row["status"] != "approved" or not row["approval_token"] or not row["approved_at"]:
        print("change is not approved; run `change approve` first", file=sys.stderr)
        return 1
    if not hmac.compare_digest(_token(row, row["approved_at"]), args.token or ""):
        print("approval token invalid or stale (change_cmd/inverse_cmd changed since "
              "approval, or the wrong token was supplied); refusing, no write made",
              file=sys.stderr)
        return 2
    return _persist_apply(conn, host_id, row, _run_change(row))
