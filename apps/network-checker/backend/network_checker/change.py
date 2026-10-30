"""Consent-gated proposal, approval, apply, verify, and rollback lifecycle.

Production proposals require an enabled template; the legacy no-host form is
a direct-test seam. Execution is shell-free and capabilities are stored only as
digests. Only a successful forward with failed verification runs its inverse.
"""
import hmac
import sys

from .change_outcomes import _persist_apply, _propose_error
from .change_security import (
    _APP_ROOT, _current_user, _key_file, _load_or_create_key, _now, _run_verify,
    _token, _token_digest, _verify_with_retry, execute,
)
from .change_templates import TEMPLATES

_TERMINAL_STATUSES = frozenset({
    "applied", "verified", "rolled_back", "apply_failed", "rollback_failed", "rejected",
})
# In-flight rows are locked against every other lifecycle mutation.
_LOCKED_STATUSES = _TERMINAL_STATUSES | {"applying"}
_LOCKED_SQL = "(" + ",".join(f"'{s}'" for s in sorted(_LOCKED_STATUSES)) + ")"
_HOST_SQL = ("(host_id=? OR (host_id IS NULL"
             " AND ?=(SELECT min(id) FROM hosts)"
             " AND (SELECT count(*) FROM hosts)=1))")
_PROPOSAL_FIELDS = ("device", "cause", "title", "cmd", "inverse", "verify")
_TEMPLATE_FIELDS = (("cause", "cause"), ("title", "title"),
                    ("cmd", "change_cmd"), ("inverse", "inverse_cmd"),
                    ("verify", "verify_probe"))
_KNOWN_TEMPLATES = frozenset(
    tuple(template[key] for _arg, key in _TEMPLATE_FIELDS)
    for template in TEMPLATES.values()
    if isinstance(template, dict) and all(key in template for _arg, key in _TEMPLATE_FIELDS))


def _get(conn, change_id, host_id=None):
    if host_id is None:
        row = conn.execute("SELECT * FROM change_request WHERE id=?", (change_id,)).fetchone()
    else:
        row = conn.execute(
            f"SELECT * FROM change_request WHERE id=? AND {_HOST_SQL}",
            (change_id, host_id, host_id)).fetchone()
    return dict(row) if row else None


def _missing(change_id):
    print(f"change {change_id} not found", file=sys.stderr)
    return 1


def _known_template(values):
    device, *requested = values
    return ((device is None or type(device) is int)
            and all(type(value) is str for value in requested)
            and tuple(requested) in _KNOWN_TEMPLATES)


def propose(conn, host_id, args=None):
    if args is None:  # backward-compatible unscoped direct-test seam
        args, host_id = host_id, None
    values = tuple(getattr(args, field, None) for field in _PROPOSAL_FIELDS)
    device, cause, title, cmd, inverse, verify = values
    if host_id is not None:
        if (error := _propose_error(conn, host_id, args)):
            print(error, file=sys.stderr)
            return 1
        if not _known_template(values):
            print("host-scoped proposals must exactly match an enabled change template",
                  file=sys.stderr)
            return 2
    elif device is not None:
        print("device does not belong to this host", file=sys.stderr)
        return 2
    cur = conn.execute(
        "INSERT INTO change_request (created_at, host_id, device_id, cause, title,"
        " change_cmd, inverse_cmd, verify_probe, status)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed')",
        (_now(), host_id, device, cause, title, cmd, inverse, verify))
    print(f"proposed change {cur.lastrowid}")
    return 0


def test(conn, host_id, args=None):
    """The dry-run form (05-f section 4.2): measures verify_probe once,
    read-only, and records the outcome as evidence. Never runs change_cmd or
    inverse_cmd.

    Finding 16: the final UPDATE is guarded `WHERE status NOT IN
    _LOCKED_SQL`, checked via rowcount -- before this, test() reset any
    row's status to 'tested' unconditionally, including an already-
    terminal one or one an in-flight apply() owns."""
    if args is None:  # backward-compatible direct API; the CLI always passes host_id
        args, host_id = host_id, None
    row = _get(conn, args.id, host_id)
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
        f" WHERE id=? AND (? IS NULL OR {_HOST_SQL}) AND status NOT IN {_LOCKED_SQL}",
        (output, _now(), args.id, host_id, host_id, host_id))
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


def approve(conn, host_id, args=None):
    """Interactively confirm a tested row and print its raw capability once.
    The CAS stores only its digest and binds the verifier into the HMAC.
    """
    if not sys.stdin.isatty():
        print("change approve requires an interactive terminal (stdin is not "
              "a TTY); refusing -- approval is never scriptable", file=sys.stderr)
        return 2
    if args is None:  # backward-compatible direct API; the CLI always passes host_id
        args, host_id = host_id, None
    row = _get(conn, args.id, host_id)
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
        f" status='approved' WHERE id=? AND (? IS NULL OR {_HOST_SQL})"
        " AND status='tested'",
        (approved_at, verifier, _token_digest(token), row["id"], host_id, host_id,
         host_id))
    if cur.rowcount == 0:
        print(f"change {row['id']} status changed during approval (no longer "
              "'tested'); refusing to mint a token", file=sys.stderr)
        return 1
    print(f"approved. one-use capability (run `change apply {row['id']}`; "
          f"it will prompt without echo): {token}")
    return 0


def apply(conn, host_id, args, capability=None):
    """Validate a raw capability, atomically claim the row, and execute once.

    The CLI supplies ``capability`` from a no-echo TTY prompt. ``args.token``
    remains only as a backward-compatible direct-test seam; argparse exposes no
    token option. The HMAC and its stored digest must both match before the
    compare-and-swap changes ``approved`` to ``applying``. Concurrent losers and
    crashed ``applying`` rows cannot replay the command.
    """
    row = _get(conn, args.id, host_id)
    if row is None:
        return _missing(args.id)
    if row["status"] != "approved" or not row["approval_token"] or not row["approved_at"]:
        print("change is not approved; run `change approve` first", file=sys.stderr)
        return 1
    supplied = capability if capability is not None else getattr(args, "token", "")
    if not _valid_capability(row, supplied):
        print("approval token invalid or stale (an authorized field changed since "
              "approval, or the wrong token was supplied); refusing, no write made",
              file=sys.stderr)
        return 2
    cur = conn.execute(
        "UPDATE change_request SET status='applying', host_id=coalesce(host_id, ?)"
        f" WHERE id=? AND {_HOST_SQL} AND status='approved'",
        (host_id, row["id"], host_id, host_id))
    if cur.rowcount != 1:
        print(f"change {row['id']} could not be claimed for apply (its status "
              "changed since the check above -- most likely a concurrent `apply` "
              "already claimed it); refusing, no write made", file=sys.stderr)
        return 3
    applied_at, result, reason = _run_change(row)
    final_status = _rollback(row, result) if reason == "verify_failed" else None
    return _persist_apply(conn, host_id, row, (applied_at, result, reason, final_status))


def _valid_capability(row, supplied):
    expected = _token(row, row["approved_at"], row["approved_by"])
    return (type(supplied) is str and hmac.compare_digest(expected, supplied)
            and hmac.compare_digest(_token_digest(supplied), row["approval_token"]))


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
