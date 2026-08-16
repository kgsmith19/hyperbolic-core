"""CLI presentation and argparse wiring for `network-checker change ...`, split out
of change.py to keep that file's line budget free for the security-relevant
lifecycle engine (propose/test/approve/apply/verify/rollback all live
there; this file is show/list/reject plus dispatch and parser setup).
"""
import getpass
import json
import sys

from . import change
from . import store

_SHOW_FIELDS = ("id", "status", "title", "cause", "device_id", "change_cmd",
                "inverse_cmd", "verify_probe", "dry_run_at", "approved_at",
                "approved_by", "applied_at", "verified_at", "rolled_back_at")


def verify(conn, host_id, args):
    row = change._get(conn, args.id, host_id)
    if row is None:
        return change._missing(args.id)
    ok, detail = change._run_verify(row["verify_probe"])
    print(json.dumps({"ok": ok, **detail}))
    return 0 if ok else 1


def show(conn, host_id, args):
    row = change._get(conn, args.id, host_id)
    if row is None:
        return change._missing(args.id)
    for k in _SHOW_FIELDS:
        print(f"{k}: {row[k]}")
    for k in ("dry_run_output", "apply_output"):
        if row[k]:
            print(f"{k}:\n{row[k]}")
    return 0


def list_(conn, host_id, args):
    sql = f"SELECT * FROM change_request WHERE {change._HOST_SQL}"
    params = [host_id, host_id]
    if args.status:
        sql += " AND status=?"
        params.append(args.status)
    rows = store._rows(conn.execute(sql + " ORDER BY id", params))
    for r in rows:
        # <16 rather than the original <10: 'rollback_failed' (Finding 17's
        # new terminal status) is 15 characters, one past the old width.
        print(f"{r['id']:<4} {r['status']:<16} {r['title']}")
    return 0


def reject(conn, host_id, args=None):
    """Finding 16: guarded exactly like change.test()/change.approve() --
    a row already in change._LOCKED_STATUSES (a terminal outcome, or one an
    in-flight apply() currently owns) cannot be marked 'rejected' out from
    under its real, already-decided outcome. Before this guard, reject()
    unconditionally overwrote status on any row, including one already
    verified/rolled back/applied."""
    if args is None:  # backward-compatible direct API; the CLI always passes host_id
        args, host_id = host_id, None
    row = change._get(conn, args.id, host_id)
    if row is None:
        return change._missing(args.id)
    cur = conn.execute(
        f"UPDATE change_request SET status='rejected'"
        f" WHERE id=? AND (? IS NULL OR {change._HOST_SQL})"
        f" AND status NOT IN {change._LOCKED_SQL}",
        (args.id, host_id, host_id, host_id))
    if cur.rowcount == 0:
        print(f"change {args.id} is '{row['status']}'; cannot be rejected",
              file=sys.stderr)
        return 1
    print(f"change {args.id} rejected")
    return 0


def cli(conn, host_id, args):
    """network-checker change: propose/test/show/approve/apply/verify/list/reject."""
    if args.action == "propose":
        return change.propose(conn, host_id, args)
    if args.action == "test":
        return change.test(conn, host_id, args)
    if args.action == "approve":
        return change.approve(conn, host_id, args)
    if args.action == "apply":
        if not sys.stdin.isatty():
            print("change apply requires an interactive terminal to read the approval "
                  "capability; refusing", file=sys.stderr)
            return 2
        capability = getpass.getpass("Approval capability: ")
        return change.apply(conn, host_id, args, capability)
    handlers = {"verify": verify, "show": show, "list": list_, "reject": reject}
    return handlers[args.action](conn, host_id, args)


def _add_propose_parser(acts):
    pr = acts.add_parser("propose")
    pr.add_argument("--title", required=True)
    pr.add_argument("--cause", default=None)
    pr.add_argument("--cmd", required=True)
    pr.add_argument("--inverse", required=True)
    pr.add_argument("--verify", required=True)
    pr.add_argument("--device", type=int, default=None)


def add_subparser(sub):
    """Register `network-checker change ...` on `sub`, the top-level subparsers
    object -- built here rather than in __main__.py so that file's own
    line budget stays free for everything else it already owns (the same
    reason watch.py was split out of it)."""
    ch = sub.add_parser("change", help="propose/approve/apply a gated device change")
    acts = ch.add_subparsers(dest="action", required=True)
    _add_propose_parser(acts)
    for name in ("test", "show", "approve", "verify", "reject"):
        acts.add_parser(name).add_argument("id", type=int)
    ap = acts.add_parser("apply")
    ap.add_argument("id", type=int)
    acts.add_parser("list").add_argument("--status", default=None)
    return ch
