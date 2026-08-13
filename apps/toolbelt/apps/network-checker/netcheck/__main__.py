"""netcheck CLI.

  netcheck watch      leave running; one sample per interval  <- the useful one
  netcheck probe      one sample, printed
  netcheck scan       environment snapshot (--tier quick/standard/deep)
  netcheck diagnose   ranked causes from everything collected so far
  netcheck inventory  device table, one device's config, or a config diff
  netcheck change     propose/approve/apply a gated device change
  netcheck serve      dashboard at http://127.0.0.1:8787
  netcheck sync       push unsynced rows to Supabase
  netcheck experiment tag or compare labeled probe runs (--label / --compare)
  netcheck export     write a redacted evidence bundle (--format json/markdown)
"""
import argparse
import json
import os
import platform
import socket
import subprocess
import sys
import webbrowser
from pathlib import Path

from . import (bundle, change_cli, diagnose, environ, experiment, inventory,
               llmlog, probes, rank, route as route_mod, server, store, watch)
from . import __version__

DB = Path(os.environ.get("NETCHECK_DB", Path.home() / ".netcheck" / "netcheck.db"))
TARGET = environ.TARGET  # single definition in environ.py; scan and probe must never disagree
SCAN_BUDGET_SECONDS = {"quick": 10, "standard": 60, "deep": 120}
SCAN_WORKER_ENV = "NETCHECK_SCAN_WORKER"


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
    """The open database and this machine's row in it, acquired together and never used apart."""
    DB.parent.mkdir(parents=True, exist_ok=True)
    conn = store.open_db(DB)
    return conn, store.host_id(conn, socket.gethostname(), platform.system())


def _one_probe_row(args):
    """One FR-001 measurement, culprit-tagged. Shared by probe, scan's quick
    tier (FR-018), and experiment --label -- all three want exactly this."""
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


def _cmd_scan_worker(args):
    """Execute one scan tier inside the bounded child process."""
    conn, host = connect()
    if args.tier == "quick":
        row = _one_probe_row(args)
        store.add_sample(conn, host, row)
        print(json.dumps(row, indent=2))
        return 0
    data = environ.scan(deep=(args.tier == "deep"))
    store.add_scan(conn, host, {"ts": data["ts"], "payload": json.dumps(data)})
    inventory.record_inventory(conn, host, data, data["ts"])
    print(json.dumps(data, indent=2, default=str))
    return 0


def cmd_scan(args):
    """FR-018 + NFR-009: a child process enforces the hard wall-clock ceiling; the
    marker prevents recursive spawning, and per-probe timeouts bound any grandchildren."""
    if os.environ.get(SCAN_WORKER_ENV) == "1":
        return _cmd_scan_worker(args)

    budget = SCAN_BUDGET_SECONDS[args.tier]
    env = os.environ.copy()
    env[SCAN_WORKER_ENV] = "1"
    env["NETCHECK_TARGET"] = args.target
    command = [sys.executable, "-m", "netcheck", "--target", args.target,
               "scan", "--tier", args.tier]
    try:
        result = subprocess.run(command, capture_output=True, text=True,
                                timeout=budget, env=env)
    except subprocess.TimeoutExpired:
        print(f"[netcheck] {args.tier} scan exceeded {budget}s budget", file=sys.stderr)
        return 124

    if result.stdout:
        sys.stdout.write(result.stdout)
    if result.stderr:
        sys.stderr.write(result.stderr)
    return result.returncode


def cmd_diagnose(args):
    conn, _host = db = connect()
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


def cmd_inventory(args):
    return inventory.cli(connect()[0], args)


def cmd_serve(args):
    conn, _host = db = connect()
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
    """FR-021 / UC-006: tag one probe run with a condition label, or compare two
    already-labeled runs -- mutually exclusive by construction (argparse's group)."""
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


def cmd_export(args):
    """Issue #74: a redacted, deterministic artifact from what's already
    stored -- read-only, no network call (never calls llmlog.ingest)."""
    conn, _host = connect()
    scans = store.scans(conn, 1)
    latest = json.loads(scans[0]["payload"]) if scans else {}
    data = bundle.build(store.samples(conn), store.errors(conn), latest,
                        {"os_name": platform.system()})
    text = bundle.render_json(data) if args.format == "json" else bundle.render_markdown(data)
    ext = "json" if args.format == "json" else "md"
    out = args.out or DB.parent / f"evidence-bundle.{ext}"
    out.write_text(text, encoding="utf-8")
    print(str(out))
    return 0


def _add_experiment_and_export_parsers(sub):
    """Split out of main() to keep it under the function-length budget."""
    e = sub.add_parser("experiment", help="tag or compare labeled probe runs")
    mode = e.add_mutually_exclusive_group(required=True)
    mode.add_argument("--label", help="tag one probe run and store it under this label")
    mode.add_argument("--compare", nargs=2, metavar=("LABEL1", "LABEL2"),
                      help="print median latency and state-mix for two stored labels")
    e.set_defaults(fn=cmd_experiment)
    x = sub.add_parser("export", help="write a redacted evidence bundle")
    x.add_argument("--format", choices=("json", "markdown"), default="markdown")
    x.add_argument("--out", type=Path, default=None)
    x.set_defaults(fn=cmd_export)


def main(argv=None):
    load_env()
    p = argparse.ArgumentParser(prog="netcheck", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--version", action="version", version=f"netcheck {__version__}")
    p.add_argument("--target", default=TARGET)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("probe", help="one sample").set_defaults(fn=cmd_probe)
    sc = sub.add_parser("scan", help="environment snapshot")
    sc.add_argument("--tier", choices=("quick", "standard", "deep"), default="standard")
    sc.set_defaults(fn=cmd_scan)
    sub.add_parser("diagnose", help="ranked causes").set_defaults(fn=cmd_diagnose)
    sub.add_parser("sync", help="push to Supabase").set_defaults(fn=cmd_sync)
    inv = sub.add_parser("inventory", help="device and configuration inventory")
    inv.add_argument("--device", type=int, help="current config for one device id")
    inv.add_argument("--diff", metavar="TS", help="config_item changes since TS")
    inv.set_defaults(fn=cmd_inventory)
    change_cli.add_subparser(sub).set_defaults(fn=lambda a: change_cli.cli(*connect(), a))
    w = sub.add_parser("watch", help="continuous monitor")
    w.add_argument("--interval", type=int, default=20)
    w.add_argument("--idle-every", type=int, default=15, dest="idle_every")
    w.add_argument("--idle-seconds", type=int, default=60, dest="idle_seconds")
    w.set_defaults(fn=cmd_watch)
    s = sub.add_parser("serve", help="dashboard")
    s.add_argument("--port", type=int, default=8787)
    s.add_argument("--no-open", action="store_true", dest="no_open")
    s.set_defaults(fn=cmd_serve)

    _add_experiment_and_export_parsers(sub)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
