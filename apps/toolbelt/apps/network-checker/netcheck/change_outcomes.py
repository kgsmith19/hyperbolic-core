"""Outcome persistence for the change lifecycle engine (change.py):
recording a change's final status and the config_item audit trail each
terminal status produces, once change.py has already run the change for
real (and its automatic rollback, if verification failed). Split out
purely to keep change.py's own line budget under the repo's
medium-profile 250-line ceiling (`tools/check.sh`'s file_too_long check)
once Findings 15/16/17/19 were all implemented there together --
change.py's `apply()` is the one caller of `_persist_apply()` here, and it
stays the public entry point tests call (`change.apply(...)`).

Deliberately holds no subprocess-touching code: `_run_change()`/
`_rollback()` -- the functions that call `execute()`/`_verify_with_retry()`
-- stay in change.py itself, not here, so `patch.object(change, "execute",
fake)` (and the same pattern for `_verify_with_retry`) -- the seam every
existing change.py test already relies on -- keeps intercepting them. Were
this module to import `execute`/`_verify_with_retry` at its own top level
and call them from functions defined here, it would get its own separate
namespace binding, invisible to a patch applied to change's -- a real bug
an earlier version of this split had, caught before it shipped.

Finding 17 (independent security review, re-verified against current
HEAD): `_persist_apply()` records four distinct terminal outcomes --
verified, apply_failed, rolled_back, rollback_failed -- reading off the
caller's already-computed `reason`/`final_status` (change.py's
`_run_change()`/`_rollback()` branch on the real rc/rrc; this module never
re-derives that decision, only persists it).
"""
import json
import sys

from .change_security import _now

_PROPOSE_REQUIRED = (("--cause", "cause"), ("--cmd", "cmd"),
                     ("--inverse", "inverse"), ("--verify", "verify"))


def _propose_error(conn, host_id, args):
    """Return a malformed/foreign-device proposal error, otherwise None."""
    for flag, attr in _PROPOSE_REQUIRED:
        value = getattr(args, attr)
        if flag == "--cause" and value is None:
            continue
        if value is None or not value.strip():
            return f"change propose: {flag} must not be blank"
    if args.device is None:
        return None
    owned = conn.execute(
        "SELECT 1 FROM device WHERE id=? AND host_id=?",
        (args.device, host_id)).fetchone()
    if owned is None:
        return (f"change propose: device {args.device} does not belong to "
                "this host (or does not exist); refusing")
    return None


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


def _insert_config_item(conn, device_id, key, value):
    conn.execute(
        "INSERT OR IGNORE INTO config_item (device_id, key, value, observed_at, source)"
        " VALUES (?, ?, ?, ?, 'change_apply')", (device_id, key, value, _now()))


def _record_config_item(conn, host_id, row, status_label):
    """05-f section 4.4: one config_item row per apply outcome, source
    'change_apply'. `status_label` is one of _persist_apply()'s four
    terminal outcomes (Finding 17): verified, apply_failed, rolled_back,
    rollback_failed."""
    device_id = _resolve_device_id(conn, host_id, row["device_id"])
    _insert_config_item(conn, device_id, f"change.{row['id']}", status_label)


def _record_rollback_config_items(conn, host_id, row, outcomes):
    """Keep the forward verification failure and rollback result distinct.

    Separate keys also prevent the two same-second observations from
    colliding with config_item's (device_id, key, observed_at) uniqueness.
    """
    reason, final_status = outcomes
    device_id = _resolve_device_id(conn, host_id, row["device_id"])
    _insert_config_item(conn, device_id, f"change.{row['id']}.apply", reason)
    _insert_config_item(conn, device_id, f"change.{row['id']}.rollback", final_status)


def _persist_apply(conn, host_id, row, outcome):
    """`outcome` is (applied_at, result, reason, final_status) --
    change.py's `apply()` has already run `_run_change()` and, for
    reason=='verify_failed', `_rollback()` too, before calling this.
    `final_status` is None unless reason=='verify_failed'.

    Finding 17: four distinct terminal outcomes instead of two --
    'verified'/'rolled_back' as before, plus 'apply_failed' (forward
    command failed; no write beyond that already-failed command was made)
    and 'rollback_failed' (verification failed AND recovery didn't confirm
    success either). Finding 16: every UPDATE is guarded `WHERE
    status='applying'`, the status apply() atomically claimed before
    _run_change() ran -- defense in depth, not a check expected to trip,
    kept for the same compare-and-swap shape used throughout this module."""
    applied_at, result, reason, final_status = outcome
    if reason == "verified":
        conn.execute(
            "UPDATE change_request SET applied_at=?, apply_output=?, verified_at=?,"
            " status='verified' WHERE id=? AND host_id=? AND status='applying'",
            (applied_at, json.dumps(result), _now(), row["id"], host_id))
        _record_config_item(conn, host_id, row, "verified")
        print(f"change {row['id']} applied and verified")
        return 0
    if reason == "apply_failed":
        conn.execute(
            "UPDATE change_request SET applied_at=?, apply_output=?,"
            " status='apply_failed' WHERE id=? AND host_id=? AND status='applying'",
            (applied_at, json.dumps(result), row["id"], host_id))
        _record_config_item(conn, host_id, row, "apply_failed")
        print(f"change {row['id']} command itself failed (nonzero exit); no "
              "automatic rollback attempted -- inspect apply_output and "
              "resolve by hand", file=sys.stderr)
        return 4
    return _persist_rollback(
        conn, host_id, row, (applied_at, result, reason, final_status))


def _persist_rollback(conn, host_id, row, resolution):
    """The reason=="verify_failed" branch of _persist_apply(), split out to
    stay under this module's per-function length budget -- change_cmd
    itself reported success but the post-apply probe said the target state
    was not reached, the one outcome this module's automatic-write
    invariant (NC-4, 05-f section 4) authorizes running inverse_cmd for.
    `resolution` is (applied_at, result, reason, final_status); `final_status`
    ("rolled_back" or "rollback_failed") is change.py's `_rollback()`
    result, already computed before this was called."""
    applied_at, result, reason, final_status = resolution
    rolled_back_at = _now() if final_status == "rolled_back" else None
    conn.execute(
        "UPDATE change_request SET applied_at=?, apply_output=?, rolled_back_at=?,"
        " status=? WHERE id=? AND host_id=? AND status='applying'",
        (applied_at, json.dumps(result), rolled_back_at, final_status,
         row["id"], host_id))
    _record_rollback_config_items(conn, host_id, row, (reason, final_status))
    if final_status == "rolled_back":
        print(f"change {row['id']} failed verification; rolled back", file=sys.stderr)
        return 1
    print(f"change {row['id']} failed verification AND the automatic rollback did "
          "not confirm success; the device may be left in a partial state -- "
          "investigate immediately (apply_output has both attempts' evidence)",
          file=sys.stderr)
    return 5
