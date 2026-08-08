"""netcheck CLI.

  netcheck watch      leave running; one sample per interval  <- the useful one
  netcheck probe      one sample, printed
  netcheck scan       full environment snapshot
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
import time
import webbrowser
from pathlib import Path

from . import (diagnose, environ, experiment, llmlog, probes, rank,
               route as route_mod, server, store)
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


def _ingest_errors(db):
    """Pull new LLM errors in. Cheap: resumes from the stored file offsets."""
    conn, host = db
    found, offsets = llmlog.scan_all(store.offsets(conn))
    for e in found:
        store.add_error(conn, host, e)
    store.save_offsets(conn, offsets)
    return len(found)


def cmd_probe(args):
    conn, host = connect()
    gw = route_mod.gateway()
    row = probes.sample(args.target, gw, route_mod.first_hop(gateway_ip=gw), wifi=environ.wifi())
    row["culprit"] = diagnose.culprit(row)
    store.add_sample(conn, host, row)
    print(json.dumps(row, indent=2))
    return 0


def cmd_watch(args):
    db = connect()
    route = (route_mod.gateway(), route_mod.first_hop(gateway_ip=route_mod.gateway()))
    print(f"[netcheck] watching {args.target} every {args.interval}s "
          f"(gateway {route[0]}, isp hop {route[1]}). Ctrl+C to stop.")
    snapshot = environ.scan()
    store.add_scan(db[0], db[1], {"ts": snapshot["ts"],
                                  "payload": json.dumps(snapshot)})
    tick = 0
    try:
        while True:
            tick += 1
            t0 = time.monotonic()
            route = _tick(db, args, route, tick)
            time.sleep(max(0, args.interval - (time.monotonic() - t0)))
    except KeyboardInterrupt:
        print(f"\n[netcheck] stopped after {tick} samples. Database: {DB}")
    return 0


def _ms(value):
    """A measurement, or a dash. `None` means the layer was not measurable
    on this host -- printing 'Nonems' every line reads like a bug."""
    return f"{value}ms" if value is not None else "-"


def _tick(db, args, route, tick):
    """One watch iteration: sample, store, report.

    Returns the route, which changes when the machine moves to a different
    network mid-run -- re-resolved every tick, since a cached gateway is how
    `watch` used to keep pinging the address it had at startup.
    """
    conn, host = db
    gw, hop = route
    current_gw = route_mod.gateway()
    if current_gw != gw:
        gw = current_gw
        hop = route_mod.first_hop(gateway_ip=gw)
        print(f"  gateway changed -> {gw} (isp hop {hop})")

    row = probes.sample(args.target, gw, hop, wifi=environ.wifi())
    row["culprit"] = diagnose.culprit(row)
    store.add_sample(conn, host, row)

    if tick % args.idle_every == 0:
        held = probes.idle_hold(args.target, seconds=args.idle_seconds)
        store.add_event(conn, host, {"ts": row["ts"], "kind": "idle_hold",
                                     "detail": json.dumps(held)})
        print(f"  idle-hold: {held['result']} after {held['held_s']}s")

    found = _ingest_errors(db)
    store.mirror(conn, os.environ.get("SUPABASE_URL"),
                 os.environ.get("SUPABASE_KEY"), socket.gethostname())

    print(f"[{row['ts']}] {row['culprit'] or 'ok':<10} gw={_ms(row['gw_ms'])} "
          f"inet={_ms(row['inet_ms'])} dns={_ms(row['dns_router_ms'])} "
          f"tls={_ms(row['tls_ms'])}"
          + (f"  (+{found} llm errors)" if found else ""))
    return gw, hop


def cmd_scan(args):
    conn, host = connect()
    data = environ.scan()
    store.add_scan(conn, host, {"ts": data["ts"], "payload": json.dumps(data)})
    print(json.dumps(data, indent=2, default=str))
    return 0


def cmd_diagnose(args):
    db = connect()
    conn, _host = db
    _ingest_errors(db)
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
    _ingest_errors(db)
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
    gw = route_mod.gateway()
    row = probes.sample(args.target, gw, route_mod.first_hop(gateway_ip=gw), wifi=environ.wifi())
    row["culprit"] = diagnose.culprit(row)
    store.add_sample(conn, host, row, label=args.label)
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
    sub.add_parser("scan", help="environment snapshot").set_defaults(fn=cmd_scan)
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
