"""The consent-gated change lifecycle engine (NC-4;
docs/planning/05-f-network-checker.md section 4): propose / test / approve /
apply / verify / rollback. Every device write needs a recorded dry run and
an explicit, interactive approval; the only automatic write this module
makes is the pre-approved inverse of a change that just failed verification.
CLI presentation (show/list/reject, argparse wiring) lives in
change_cli.py; the security-relevant primitives (real subprocess
execution, live verification, and the keyed approval-token machinery)
live in change_security.py; persisting an already-computed outcome (plus
the config_item audit trail) lives in change_outcomes.py -- all three
split out to keep this file's own line budget under the repo's
medium-profile ceiling (the same reason watch.py split from __main__.py).

`execute` (from change_security) is the one seam touching a real
subprocess -- change_cmd and inverse_cmd both pass through it and only it,
so a test can `patch.object(change, "execute", fake)` and prove a rejected
apply never reaches a real device. `_run_verify`/`_verify_with_retry` are
the other real seam (route_mod.*, probes.sample, environ.wifi). All three
names are re-exported here via `from .change_security import ...` rather
than referenced as `change_security.execute(...)`, specifically so that
existing pattern still intercepts calls made from this module's own
`_run_change()`/`_rollback()` below -- see change_security.py's own
module docstring for why that's safe. Those two functions (and only
those two) stay in this module rather than moving to change_outcomes.py
with the rest of the post-apply bookkeeping, precisely so that seam holds:
change_outcomes.py's own functions never call execute()/`_verify_with_retry`
themselves, only persist the (reason, final_status) this module already
computed.

Findings 15/16/17/19/61 from an independent security review, fixed
together since they touch the same state machine: (15) `_token()`
(change_security.py) is a keyed HMAC that also binds `approved_by`, not
the old unkeyed sha256; (16) `apply()` claims its row atomically before
`execute()` runs, and `test()`/`approve()`/change_cli's `reject()` all
refuse a `_LOCKED_STATUSES` row; (17) `_run_change()`/`_rollback()` branch
on the real rc/rrc instead of trusting the verify probe alone (see
`_persist_apply()`'s four outcomes); (19) `execute()` (change_security.py)
runs with its own process group, killed whole on timeout; (61) `propose()`
validates inputs (see its own docstring, and change_outcomes.py's).
"""
import hmac
import sys

from .change_outcomes import _persist_apply, _propose_error
from .change_security import (
    _APP_ROOT, _current_user, _key_file, _load_or_create_key, _now, _run_verify,
    _token, _verify_with_retry, execute,
)

_TERMINAL_STATUSES = frozenset({
    "applied", "verified", "rolled_back", "apply_failed", "rollback_failed", "rejected",
})
# 'applying' is not itself a dead end, but a row an in-flight apply() owns
# must be just as off-limits to test()/approve()/reject() as a terminal row
# (Finding 16) -- built from the frozenset above so the SQL text below and
# the Python-side membership checks can't drift; safe to splice into SQL
# since every member is a fixed identifier this module owns, never input.
_LOCKED_STATUSES = _TERMINAL_STATUSES | {"applying"}
_LOCKED_SQL = "(" + ",".join(f"'{s}'" for s in sorted(_LOCKED_STATUSES)) + ")"


def _get(conn, change_id):
    row = conn.execute("SELECT * FROM change_request WHERE id=?", (change_id,)).fetchone()
    return dict(row) if row else None


def _missing(change_id):
    print(f"change {change_id} not found", file=sys.stderr)
    return 1


def propose(conn, host_id, args):
    """Finding 61: validated by _propose_error() (change_outcomes.py) before the INSERT runs."""
    if (error := _propose_error(conn, host_id, args)):
        print(error, file=sys.stderr)
        return 1
    cur = conn.execute(
        "INSERT INTO change_request (created_at, device_id, cause, title, change_cmd,"
        " inverse_cmd, verify_probe, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed')",
        (_now(), args.device, args.cause, args.title, args.cmd, args.inverse, args.verify))
    print(f"proposed change {cur.lastrowid}")
    return 0


def test(conn, args):
    """The dry-run form (05-f section 4.2): measures verify_probe once,
    read-only, and records the outcome as evidence. Never runs change_cmd or
    inverse_cmd.

    Finding 16: the final UPDATE is guarded `WHERE status NOT IN
    _LOCKED_SQL`, checked via rowcount -- before this, test() reset any
    row's status to 'tested' unconditionally, including an already-
    terminal one or one an in-flight apply() owns."""
    row = _get(conn, args.id)
    if row is None:
        return _missing(args.id)
    if row["status"] in _LOCKED_STATUSES:
        print(f"change {args.id} is '{row['status']}'; cannot be (re)tested",
              file=sys.stderr)
        return 1
    ok, detail = _run_verify(row["verify_probe"])
    output = (f"DRY-RUN: would run: {row['change_cmd']}\n"
             f"DRY-RUN: inverse on failed verify: {row['inverse_cmd']}\n"
             f"DRY-RUN: current state ({row['verify_probe']}): "
             f"{'already satisfied' if ok else 'not yet satisfied'} ({detail})")
    cur = conn.execute(
        f"UPDATE change_request SET dry_run_output=?, dry_run_at=?, status='tested'"
        f" WHERE id=? AND status NOT IN {_LOCKED_SQL}",
        (output, _now(), args.id))
    if cur.rowcount == 0:
        print(f"change {args.id} status changed while this dry run was measured; "
              "not recorded", file=sys.stderr)
        return 1
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
    """05-f section 4.3: interactive only. Refuses when stdin is not a
    TTY -- never scriptable, never automatic -- then requires the operator
    to type the id back before minting the token.

    Finding 16: requires status=='tested', and the minting UPDATE is a
    compare-and-swap guarded `WHERE status='tested'` -- before this, any
    row with `dry_run_output` ever set (which never clears) could be
    re-approved regardless of current status. Finding 15c: `approved_by`
    is frozen into the row and folded into the token, so tampering with it
    afterward invalidates the token like a tampered change_cmd."""
    if not sys.stdin.isatty():
        print("change approve requires an interactive terminal (stdin is not "
              "a TTY); refusing -- approval is never scriptable", file=sys.stderr)
        return 2
    row = _get(conn, args.id)
    if row is None:
        return _missing(args.id)
    if row["status"] != "tested":
        print(f"change {args.id} is '{row['status']}', not 'tested'; approve "
              "requires a fresh dry run first (run `change test`)", file=sys.stderr)
        return 1
    _print_record(row)
    typed = input(f"Type the change id ({row['id']}) to approve, anything else to abort: ")
    if typed.strip() != str(row["id"]):
        print("approval aborted; id did not match", file=sys.stderr)
        return 1
    approved_at = _now()
    verifier = _current_user()
    token = _token(row, approved_at, verifier)
    cur = conn.execute(
        "UPDATE change_request SET approved_at=?, approved_by=?, approval_token=?,"
        " status='approved' WHERE id=? AND status='tested'",
        (approved_at, verifier, token, row["id"]))
    if cur.rowcount == 0:
        print(f"change {row['id']} status changed during approval (no longer "
              "'tested'); refusing to mint a token", file=sys.stderr)
        return 1
    print(f"approved. token (use with `change apply --token`): {token}")
    return 0


def apply(conn, host_id, args):
    """05-f section 4.1 invariant 2 / section 4.3: a row cannot reach
    `applied` without a valid, freshly-recomputed approval token; every
    precondition is checked before execute() runs, so a rejected apply
    makes no device write at all (NC-4.1).

    Finding 16: after the token check, this claims the row atomically --
    `UPDATE ... SET status='applying' WHERE id=? AND status='approved'`,
    checked via rowcount -- before `_run_change()`/`execute()` ever run.
    SQLite serializes writers on one database, so of two concurrent
    `apply` calls on the same row only one UPDATE can observe 'approved';
    the loser observes 'applying' and refuses (return 3) without calling
    execute(). This also closes the old crash-consistency gap: a crash
    between execute() and the final UPDATE used to leave the row
    'approved' with its still-valid token, replayable; now it leaves
    'applying' -- not 'approved', so it cannot be replayed, intentionally
    stuck pending manual inspection (fail-closed, for a device write)."""
    row = _get(conn, args.id)
    if row is None:
        return _missing(args.id)
    if row["status"] != "approved" or not row["approval_token"] or not row["approved_at"]:
        print("change is not approved; run `change approve` first", file=sys.stderr)
        return 1
    if not hmac.compare_digest(
            _token(row, row["approved_at"], row["approved_by"]), args.token or ""):
        print("approval token invalid or stale (change_cmd/inverse_cmd/approved_by "
              "changed since approval, or the wrong token was supplied); refusing, "
              "no write made", file=sys.stderr)
        return 2
    cur = conn.execute(
        "UPDATE change_request SET status='applying' WHERE id=? AND status='approved'",
        (row["id"],))
    if cur.rowcount != 1:
        print(f"change {row['id']} could not be claimed for apply (its status "
              "changed since the check above -- most likely a concurrent `apply` "
              "already claimed it); refusing, no write made", file=sys.stderr)
        return 3
    applied_at, result, reason = _run_change(row)
    final_status = _rollback(row, result) if reason == "verify_failed" else None
    return _persist_apply(conn, host_id, row, (applied_at, result, reason, final_status))


def _run_change(row):
    """Apply change_cmd for real, then verify it. Returns (applied_at,
    result, reason); reason is "apply_failed" | "verified" | "verify_failed".

    Finding 17: `rc` is now a first-class outcome, not just captured. A
    nonzero rc skips verification outright ("apply_failed") instead of
    trusting a probe that might read 'ok' for reasons unrelated to this
    command -- matching AGENTS.md's automatic-write invariant precisely: a
    command that failed outright never reached verification, so apply()
    never runs inverse_cmd for this outcome."""
    rc, out, err = execute(row["change_cmd"])
    applied_at = _now()
    result = {"apply": {"returncode": rc, "stdout": out, "stderr": err}}
    if rc != 0:
        return applied_at, result, "apply_failed"
    ok, log = _verify_with_retry(row["verify_probe"])
    result["verify_attempts"] = log
    return applied_at, result, ("verified" if ok else "verify_failed")


def _rollback(row, result):
    """05-f section 4.4: run inverse_cmd once verification has failed, then
    one follow-up verify to confirm restoration -- the only automatic
    device write this module makes. Returns "rolled_back" or
    "rollback_failed".

    Finding 17: `rrc` and the post-restore verify now both decide the
    result (the old code captured `rrc` but never checked it, and bound
    the post-restore verify to `_ok`, this codebase's convention for
    "deliberately unused" -- reporting 'rolled_back' regardless of whether
    the restore worked was the bug). 'rolled_back' now requires both to
    confirm success; anything else is 'rollback_failed', the most urgent
    status this lifecycle can reach."""
    rrc, rout, rerr = execute(row["inverse_cmd"])
    result["rollback"] = {"returncode": rrc, "stdout": rout, "stderr": rerr}
    rollback_ok, log = _verify_with_retry(row["verify_probe"], attempts=1, budget_s=30)
    result["rollback_verify"] = log
    return "rolled_back" if (rrc == 0 and rollback_ok) else "rollback_failed"
