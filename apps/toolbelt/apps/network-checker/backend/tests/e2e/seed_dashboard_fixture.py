#!/usr/bin/env python3
"""Seed (or append to) the fixture SQLite database the D-04 Playwright
dashboard smoke spec drives `python -m network_checker serve` against.

Stdlib only, matching this app's hard rule (AGENTS.md) -- this script is
test-time tooling, not shipped product, but there is no reason for it to
reach past the standard library either.

Two modes:
  (default)  build the fixture fresh: delete any previous copy, write the
             seed sample rows plus one small environment scan. This is the
             CI "prepare" step, and how to (re)build the fixture locally.
  --append   add exactly one more sample row, with a culprit no seed row
             carries, to an already-seeded (and possibly already-serving)
             database. The Playwright spec calls this mid-test to prove a
             live SSE push reaches the page without a reload -- there is no
             other way to make new data appear against a hermetic fixture
             with no real probes running.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from network_checker import diagnose, store  # noqa: E402  (path must be set up first)

DB_PATH = Path(__file__).resolve().parent / "dashboard-fixture.db"
HOST_NAME = "dashboard-fixture-host"


def _row(ts, ms_value, **overrides):
    """A fully healthy sample row at `ts`, every *_ms field derived from
    `ms_value` so each seeded row renders a distinct, greppable number."""
    row = {"ts": ts, "gw_state": "ok", "hop_state": "ok", "inet_state": "ok",
           "dns_router_state": "ok", "dns_public_state": "ok",
           "tls_state": "ok", "http_state": "ok",
           "gw_ms": ms_value, "inet_ms": ms_value + 1,
           "dns_router_ms": ms_value + 2, "tls_ms": ms_value + 3}
    row.update(overrides)
    return row


# Five ticks' worth of history; the last one fails the gateway probe, so the
# fixture has a real, non-"ok" culprit for the smoke spec to look for -- the
# same shape a real `network-checker watch` run leaves behind.
FIXTURE_ROWS = (
    _row("2026-08-01T12:00:00+00:00", 11.0),
    _row("2026-08-01T12:00:20+00:00", 12.0),
    _row("2026-08-01T12:00:40+00:00", 13.0),
    _row("2026-08-01T12:01:00+00:00", 14.0),
    _row("2026-08-01T12:01:20+00:00", 321.0, gw_state="fail"),
)

# What the SSE-push assertion looks for: a distinct ms marker and a culprit
# ("internet") that no FIXTURE_ROWS entry carries, appended after the page
# has already loaded and rendered the rows above.
LIVE_UPDATE_ROW = _row("2026-08-01T12:05:00+00:00", 777.0, inet_state="fail")


def _fresh(path):
    """Delete any previous fixture database and its WAL/SHM sidecars so a
    re-run starts clean rather than accumulating old rows."""
    for suffix in ("", "-wal", "-shm"):
        path.with_name(path.name + suffix).unlink(missing_ok=True)


def seed(conn):
    """Write the fixture rows fresh: the host row, every FIXTURE_ROWS
    sample (culprit computed the same way _tick computes it, not
    hardcoded), and one small environment scan."""
    host = store.host_id(conn, HOST_NAME, "Linux")
    for row in FIXTURE_ROWS:
        stored = dict(row, culprit=diagnose.culprit(row))
        store.add_sample(conn, host, stored)
    store.add_scan(conn, host, {
        "ts": FIXTURE_ROWS[0]["ts"],
        "payload": json.dumps({"wifi": {"state": "ok", "ssid": "fixture-wifi",
                                        "channel": 44}}),
    })
    return host


def append_one(conn):
    """Add exactly one more sample: the live-update marker row."""
    host = store.host_id(conn, HOST_NAME, "Linux")
    row = dict(LIVE_UPDATE_ROW, culprit=diagnose.culprit(LIVE_UPDATE_ROW))
    store.add_sample(conn, host, row)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--append", action="store_true",
                        help="add one more sample to an existing fixture DB")
    parser.add_argument("--db", type=Path, default=DB_PATH)
    args = parser.parse_args(argv)

    if not args.append:
        _fresh(args.db)

    conn = store.open_db(args.db)
    if args.append:
        append_one(conn)
    else:
        seed(conn)
    conn.close()
    print(str(args.db))
    return 0


if __name__ == "__main__":
    sys.exit(main())
