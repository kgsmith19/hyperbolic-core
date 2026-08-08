"""netcheck CLI.

  netcheck watch      leave running; one sample per interval  <- the useful one
  netcheck probe      one sample, printed
  netcheck scan       environment snapshot (--tier quick/standard/deep)
  netcheck diagnose   ranked causes from everything collected so far
  netcheck serve      dashboard at http://127.0.0.1:8787
  netcheck sync       push unsynced rows to Supabase
  netcheck experiment tag or compare labeled probe runs (--label / --compare)
"""
import argparse
import json
import os
import platform
import socket
import sys
import webbrowser
from pathlib import Path

from . import (diagnose, environ, experiment, llmlog, probes, rank,
               route as route_mod, server, store, watch)
from . import __version__

DB = Path(os.environ.get("NETCHECK_DB", Path.home() / ".netcheck" / "netcheck.db"))
TARGET = environ.TARGET  # single definition in environ.py; scan and probe must never disagree


def load_env(path=Path(".env")):
    """Minimal .env reader. Credentials never belong in the repo or in argv."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"\''))


def connect():
    """The open database and this machine's row in it. Always acquired
    together and never used apart, so they travel as one value."""
    DB.parent.mkdir(parents=True, exist_ok=True)
    conn = store.open_db(DB)
    return conn, store.host_id(conn, socket.gethostname(), platform.system())


def _one_probe_row(args):
    """One FR-001 measurement, culprit-tagged. Shared by probe, scan's
    quick tier (FR-018), and experiment --label -- all three want exactly
    this and nothing more."""
    gw = route_mod.gateway()
    row = probes.sample(args.target, gw, route_mod.first_hop(gateway_ip=gw), wifi=environ.wifi())
    row["culprit"] = diagnose.culprit(row)
    return row


def cmd_probe(args):
    conn, host = connect()
    row = _one_probe_row(args)
    store.add_sample(conn, host, row)
    print(json.dumps(row, indent=2))
    return 0


def cmd_watch(args):
    return watch.run(connect(), args, DB)


def cmd_scan(args):
    """FR-018: quick is _one_probe_row's FR-001 measurement; standard and
    deep are environ.scan(), the latter with deep=True."""
    conn, host = connect()
    if args.tier == "quick":
        row = _one_probe_row(args)
        store.add_sample(conn, host, row)
        print(json.dumps(row, indent=2))
        return 0
    data = environ.scan(deep=(args.tier == "deep"))
    store.add_scan(conn, host, {"ts": data["ts"], "payload": json.dumps(data)})
    print(json.dumps(data, indent=2, default=str))
    return 0


def cmd_diagnose(args):
    db = connect()
    conn, _host = db
    llmlog.ingest(db)
    samples = store.samples(conn)
    raw = store.errors(conn)
    scans = store.scans(conn, 1)
    latest = json.loads(scans[0]["payload"]) if scans else {}
    errors = diagnose.correlate(raw, samples)
    causes = rank.rank(samples, errors, latest)

    # ASCII only: the Windows console codepage mangles anything else.
    print(f"\nnetcheck - {len(samples)} samples, {len(raw)} LLM errors\n")
    if not causes:
        print("  No causes identified yet. Leave `netcheck watch` running so the "
              "next failure lands beside a measured sample.\n")
    for n, c in enumerate(causes, 1):
        print(f"  {n}. {c['cause']}  [{c['confidence']}]")
        print(f"     evidence: {c['evidence']}")
        print(f"     fix:      {c['fix']}\n")

    verdicts = {}
    for e in errors:
        verdicts[e["verdict"]] = verdicts.get(e["verdict"], 0) + 1
    if verdicts:
        print("  LLM errors by verdict: "
              + ", ".join(f"{v} {k}" for k, v in sorted(verdicts.items(), key=lambda x: -x[1])))
    return 0


def cmd_serve(args):
    db = connect()
    conn, _host = db
    llmlog.ingest(db)
    httpd = server.serve(conn, args.port)
    url = f"http://127.0.0.1:{args.port}"
    print(f"[netcheck] dashboard at {url}  (Ctrl+C to stop)")
    if not args.no_open:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()
    return 0


def cmd_sync(args):
    conn, _ = connect()
    result = store.mirror(conn, os.environ.get("SUPABASE_URL"),
                          os.environ.get("SUPABASE_KEY"), socket.gethostname())
    print(json.dumps(result, indent=2))
    return 0 if result.get("state") != "fail" else 1


def cmd_experiment(args):
    """FR-021 / UC-006: tag one probe run with a condition label, or compare
    two already-labeled runs. Mutually exclusive by construction (argparse's
    mutually-exclusive group), so exactly one mode runs per invocation."""
    conn, host = connect()
    if args.compare:
        label_a, label_b = args.compare
        result = experiment.compare(store.samples_by_label(conn, label_a),
                                    store.samples_by_label(conn, label_b))
        print(experiment.format_report(label_a, label_b, result))
        return 0
    store.add_sample(conn, host, _one_probe_row(args), label=args.label)
    print(f"[netcheck] stored 1 sample labeled {args.label!r}")
    return 0


def main(argv=None):
    load_env()
    p = argparse.ArgumentParser(prog="netcheck", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--version", action="version",
                   version=f"netcheck {__version__}")
    p.add_argument("--target", default=TARGET)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("probe", help="one sample").set_defaults(fn=cmd_probe)
    sc = sub.add_parser("scan", help="environment snapshot")
    sc.add_argument("--tier", choices=("quick", "standard", "deep"), default="standard")
    sc.set_defaults(fn=cmd_scan)
    sub.add_parser("diagnose", help="ranked causes").set_defaults(fn=cmd_diagnose)
    sub.add_parser("sync", help="push to Supabase").set_defaults(fn=cmd_sync)

    w = sub.add_parser("watch", help="continuous monitor")
    w.add_argument("--interval", type=int, default=20)
    w.add_argument("--idle-every", type=int, default=15, dest="idle_every")
    w.add_argument("--idle-seconds", type=int, default=60, dest="idle_seconds")
    w.set_defaults(fn=cmd_watch)

    s = sub.add_parser("serve", help="dashboard")
    s.add_argument("--port", type=int, default=8787)
    s.add_argument("--no-open", action="store_true", dest="no_open")
    s.set_defaults(fn=cmd_serve)

    e = sub.add_parser("experiment", help="tag or compare labeled probe runs")
    mode = e.add_mutually_exclusive_group(required=True)
    mode.add_argument("--label", help="tag one probe run and store it under this label")
    mode.add_argument("--compare", nargs=2, metavar=("LABEL1", "LABEL2"),
                      help="print median latency and state-mix for two stored labels")
    e.set_defaults(fn=cmd_experiment)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
