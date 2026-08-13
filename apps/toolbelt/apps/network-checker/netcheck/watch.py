"""The `netcheck watch` loop: one probe per interval, re-resolving the
route each tick so a network switch is detected, not misread as an outage.

Split out of __main__.py to keep that file under the length budget as CLI
surface grows (FR-018's --tier flag, FR-021's experiment subcommand) --
this loop's pieces are only ever used together and by nothing else.
"""
import argparse
import json
import os
import socket
import time

from . import diagnose, environ, llmlog, probes
from . import route as route_mod
from . import store


def _positive_int(value):
    """argparse `type=` for __main__.py's --interval/--idle-every (Finding
    64, independent security review): both were plain `type=int` with no
    minimum, so `--idle-every 0` (or negative) reached `_tick`'s `tick %
    args.idle_every` below as a real ZeroDivisionError instead of a clean
    CLI error at parse time. Lives here, not __main__.py, since these two
    args exist only for this loop and __main__.py's own line budget has no
    room to spare."""
    n = int(value)
    if n <= 0:
        raise argparse.ArgumentTypeError(f"must be a positive integer, got {value!r}")
    return n


def _ms(value):
    """A measurement, or a dash. `None` means the layer was not measurable
    on this host -- printing 'Nonems' every line reads like a bug."""
    return f"{value}ms" if value is not None else "-"


def _tick(db, args, route, tick):
    """One watch iteration: sample, store, report. Returns the route, which
    changes when the machine moves to a different network mid-run --
    re-resolved every tick, since a cached gateway is how `watch` used to
    keep pinging the address it had at startup."""
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

    found = llmlog.ingest(db)
    store.mirror(conn, os.environ.get("SUPABASE_URL"),
                 os.environ.get("SUPABASE_KEY"), socket.gethostname())

    print(f"[{row['ts']}] {row['culprit'] or 'ok':<10} gw={_ms(row['gw_ms'])} "
          f"inet={_ms(row['inet_ms'])} dns={_ms(row['dns_router_ms'])} "
          f"tls={_ms(row['tls_ms'])}"
          + (f"  (+{found} llm errors)" if found else ""))
    return gw, hop


def run(db, args, db_path):
    """netcheck watch: leave running, one sample per interval.

    Finding 64 (independent security review): the initial gateway lookup
    is cached in `gw` and reused for `first_hop`'s own gateway_ip, rather
    than calling route_mod.gateway() a second time for the same value one
    expression later -- a pure refactor, no behavior change (route_mod.
    gateway() is a repeatable read, not a mutation)."""
    gw = route_mod.gateway()
    route = (gw, route_mod.first_hop(gateway_ip=gw))
    print(f"[netcheck] watching {args.target} every {args.interval}s "
          f"(gateway {route[0]}, isp hop {route[1]}). Ctrl+C to stop.")
    snapshot = environ.scan()
    store.add_scan(db[0], db[1], {"ts": snapshot["ts"], "payload": json.dumps(snapshot)})
    tick = 0
    try:
        while True:
            tick += 1
            t0 = time.monotonic()
            route = _tick(db, args, route, tick)
            time.sleep(max(0, args.interval - (time.monotonic() - t0)))
    except KeyboardInterrupt:
        print(f"\n[netcheck] stopped after {tick} samples. Database: {db_path}")
    return 0
