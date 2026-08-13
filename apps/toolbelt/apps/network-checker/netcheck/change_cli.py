"""CLI presentation and argparse wiring for `netcheck change ...`, split out
of change.py to keep that file's line budget free for the security-relevant
lifecycle engine (propose/test/approve/apply/verify/rollback all live
there; this file is show/list/reject plus dispatch and parser setup).
"""
import json

from . import change
from . import store

_SHOW_FIELDS = ("id", "status", "title", "cause", "device_id", "change_cmd",
                "inverse_cmd", "verify_probe", "dry_run_at", "approved_at",
                "applied_at", "verified_at", "rolled_back_at")


def verify(conn, args):
    row = change._get(conn, args.id)
    if row is None:
        return change._missing(args.id)
    ok, detail = change._run_verify(row["verify_probe"])
    print(json.dumps({"ok": ok, **detail}))
    return 0 if ok else 1


def show(conn, args):
    row = change._get(conn, args.id)
    if row is None:
        return change._missing(args.id)
    for k in _SHOW_FIELDS:
        print(f"{k}: {row[k]}")
    for k in ("dry_run_output", "apply_output"):
        if row[k]:
            print(f"{k}:\n{row[k]}")
    return 0


def list_(conn, args):
    if args.status:
        rows = store._rows(conn.execute(
            "SELECT * FROM change_request WHERE status=? ORDER BY id", (args.status,)))
    else:
        rows = store._rows(conn.execute("SELECT * FROM change_request ORDER BY id"))
    for r in rows:
        print(f"{r['id']:<4} {r['status']:<10} {r['title']}")
    return 0


def reject(conn, args):
    row = change._get(conn, args.id)
    if row is None:
        return change._missing(args.id)
    conn.execute("UPDATE change_request SET status='rejected' WHERE id=?", (args.id,))
    print(f"change {args.id} rejected")
    return 0


def cli(conn, host_id, args):
    """netcheck change: propose/test/show/approve/apply/verify/list/reject."""
    if args.action == "propose":
        return change.propose(conn, args)
    if args.action == "test":
        return change.test(conn, args)
    if args.action == "approve":
        return change.approve(conn, args)
    if args.action == "apply":
        return change.apply(conn, host_id, args)
    handlers = {"verify": verify, "show": show, "list": list_, "reject": reject}
    return handlers[args.action](conn, args)


def _add_propose_parser(acts):
    pr = acts.add_parser("propose")
    pr.add_argument("--title", required=True)
    pr.add_argument("--cause", default=None)
    pr.add_argument("--cmd", required=True)
    pr.add_argument("--inverse", required=True)
    pr.add_argument("--verify", required=True)
    pr.add_argument("--device", type=int, default=None)


def add_subparser(sub):
    """Register `netcheck change ...` on `sub`, the top-level subparsers
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
    ap.add_argument("--token", required=True)
    acts.add_parser("list").add_argument("--status", default=None)
    return ch
