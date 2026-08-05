"""netcheck CLI.

  netcheck watch      leave running; one sample per interval  <- the useful one
  netcheck probe      one sample, printed
  netcheck scan       full environment snapshot
  netcheck diagnose   ranked causes from everything collected so far
  netcheck serve      dashboard at http://127.0.0.1:8787
  netcheck sync       push unsynced rows to Supabase
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

from . import diagnose, environ, llmlog, probes, server, store, all_diagnostics
from . import __version__

DB = Path(os.environ.get("NETCHECK_DB", Path.home() / ".netcheck" / "netcheck.db"))
TARGET = os.environ.get("NETCHECK_TARGET", "api.anthropic.com")


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
    DB.parent.mkdir(parents=True, exist_ok=True)
    conn = store.open_db(DB)
    return conn, store.host_id(conn, socket.gethostname(), platform.system())


def _ingest_errors(conn, host):
    """Pull new LLM errors in. Cheap: resumes from the stored file offsets."""
    found, offsets = llmlog.scan_all(store.offsets(conn))
    for e in found:
        store.add_error(conn, host, e)
    store.save_offsets(conn, offsets)
    return len(found)


def cmd_probe(args):
    conn, host = connect()
    gw = probes.gateway()
    row = probes.sample(args.target, gw, probes.first_hop(gateway_ip=gw),
                        wifi=environ.wifi())
    row["culprit"] = diagnose.culprit(row)
    store.add_sample(conn, host, row)
    print(json.dumps(row, indent=2))
    return 0


def cmd_watch(args):
    conn, host = connect()
    gw = probes.gateway()
    hop = probes.first_hop(gateway_ip=gw)
    print(f"[netcheck] watching {args.target} every {args.interval}s "
          f"(gateway {gw}, isp hop {hop}). Ctrl+C to stop.")
    store.add_scan(conn, host, {"ts": environ.scan()["ts"],
                                "payload": json.dumps(environ.scan())})
    tick = 0
    try:
        while True:
            tick += 1
            t0 = time.monotonic()
            row = probes.sample(args.target, gw, hop, wifi=environ.wifi())
            row["culprit"] = diagnose.culprit(row)
            store.add_sample(conn, host, row)

            if tick % args.idle_every == 0:
                held = probes.idle_hold(args.target, seconds=args.idle_seconds)
                store.add_event(conn, host, {"ts": row["ts"], "kind": "idle_hold",
                                             "detail": json.dumps(held)})
                print(f"  idle-hold: {held['result']} after {held['held_s']}s")

            found = _ingest_errors(conn, host)
            store.mirror(conn, os.environ.get("SUPABASE_URL"),
                         os.environ.get("SUPABASE_KEY"), socket.gethostname())

            flag = row["culprit"] or "ok"
            print(f"[{row['ts']}] {flag:<10} gw={row['gw_ms']}ms "
                  f"inet={row['inet_ms']}ms dns={row['dns_router_ms']}ms "
                  f"tls={row['tls_ms']}ms"
                  + (f"  (+{found} llm errors)" if found else ""))
            time.sleep(max(0, args.interval - (time.monotonic() - t0)))
    except KeyboardInterrupt:
        print(f"\n[netcheck] stopped after {tick} samples. Database: {DB}")
    return 0


def cmd_scan(args):
    conn, host = connect()
    data = environ.scan()
    store.add_scan(conn, host, {"ts": data["ts"], "payload": json.dumps(data)})
    print(json.dumps(data, indent=2, default=str))
    return 0


def cmd_diagnose(args):
    conn, host = connect()
    _ingest_errors(conn, host)
    samples = store.samples(conn)
    raw = store.errors(conn)
    scans = store.scans(conn, 1)
    latest = json.loads(scans[0]["payload"]) if scans else {}
    errors = diagnose.correlate(raw, samples)
    causes = diagnose.rank(samples, errors, latest)

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
    conn, host = connect()
    _ingest_errors(conn, host)
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


def cmd_full_check(args):
    """Run comprehensive diagnostics on all 15 hypotheses."""
    runner = all_diagnostics.AllDiagnostics()

    if args.format == "quick":
        print(runner.get_quick_diagnosis())
    else:
        result = runner.run_all()
        print(json.dumps(result, indent=2, default=str))
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

    fc = sub.add_parser("full-check", help="comprehensive diagnostics")
    fc.add_argument("--format", choices=["quick", "json"], default="json",
                    help="output format (quick for summary, json for full)")
    fc.set_defaults(fn=cmd_full_check)

    w = sub.add_parser("watch", help="continuous monitor")
    w.add_argument("--interval", type=int, default=20)
    w.add_argument("--idle-every", type=int, default=15, dest="idle_every")
    w.add_argument("--idle-seconds", type=int, default=60, dest="idle_seconds")
    w.set_defaults(fn=cmd_watch)

    s = sub.add_parser("serve", help="dashboard")
    s.add_argument("--port", type=int, default=8787)
    s.add_argument("--no-open", action="store_true", dest="no_open")
    s.set_defaults(fn=cmd_serve)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
