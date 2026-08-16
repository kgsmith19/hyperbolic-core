"""Hermetic tests for the `network-checker watch` tick loop (D-03).

watch.py is the one module in this codebase with no dedicated test
(docs/planning/05-f-network-checker.md section 5) despite being the
long-running loop every other measurement feeds. Every seam watch.py
imports -- probes.sample, probes.idle_hold, route_mod.gateway,
route_mod.first_hop, environ.wifi, environ.scan, llmlog.ingest,
store.mirror, and time.sleep -- is patched here at its point of use in
network_checker.watch, so nothing below opens a real socket, shells out, or waits
on a real clock. store itself is real (an in-memory SQLite database), the
same way test_store.py and test_server.py exercise it, so a stored row is
proof of behavior rather than proof a mock was configured correctly.
"""
import argparse
import contextlib
import io
import json
import os
import socket
import unittest
from pathlib import Path
from unittest.mock import patch

from network_checker import store, watch


def _healthy_row(ts, **overrides):
    """A fully healthy sample row: every layer 'ok', so the real
    diagnose.culprit() invoked inside _tick computes None from it. Carries
    the *_ms fields too -- _tick's own status print reads them by bracket
    access, exactly like the real probes.sample() row it stands in for."""
    row = {"ts": ts, "gw_state": "ok", "hop_state": "ok", "inet_state": "ok",
           "dns_router_state": "ok", "dns_public_state": "ok",
           "tls_state": "ok", "http_state": "ok",
           "gw_ms": 5.0, "inet_ms": 6.0, "dns_router_ms": 4.0, "tls_ms": 40.0}
    row.update(overrides)
    return row


def _args(**overrides):
    """A minimal `network-checker watch` argparse.Namespace, the same shape
    __main__.py's watch subparser builds."""
    base = {"target": "api.anthropic.com", "interval": 20,
            "idle_every": 1000, "idle_seconds": 5}
    base.update(overrides)
    return argparse.Namespace(**base)


class TickStoresSampleTest(unittest.TestCase):
    """_tick is the unit that turns one measurement into one stored row;
    `culprit` must be the real diagnose.culprit() result for the row the
    fake probes.sample() handed back, not a value _tick invents itself."""

    def setUp(self):
        self.conn = store.open_db(":memory:")
        self.addCleanup(self.conn.close)
        self.host = store.host_id(self.conn, "watch-test-host", "Linux")

    def test_one_tick_stores_one_row_with_culprit_from_the_fake_sample(self):
        row = _healthy_row("2026-08-12T00:00:00+00:00", gw_state="fail")
        with patch.object(watch.route_mod, "gateway", return_value="10.0.0.1"), \
             patch.object(watch.route_mod, "first_hop", return_value="203.0.113.1"), \
             patch.object(watch.probes, "sample", return_value=dict(row)) as sample, \
             patch.object(watch.probes, "idle_hold") as idle_hold, \
             patch.object(watch.environ, "wifi", return_value={"state": "unavailable"}), \
             patch.object(watch.llmlog, "ingest", return_value=0), \
             patch.object(watch.store, "mirror", return_value={"state": "unavailable"}), \
             contextlib.redirect_stdout(io.StringIO()):
            watch._tick((self.conn, self.host), _args(),
                       ("10.0.0.1", "203.0.113.1"), 1)

        sample.assert_called_once_with("api.anthropic.com", "10.0.0.1", "203.0.113.1",
                                       wifi={"state": "unavailable"})
        idle_hold.assert_not_called()
        rows = store.samples(self.conn)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["culprit"], "lan")
        self.assertEqual(rows[0]["gw_state"], "fail")


class RunLoopTest(unittest.TestCase):
    """The tick loop has no natural exit; Ctrl+C (KeyboardInterrupt) is the
    only way `run()` stops, so a test bounds it by making the patched
    time.sleep raise after N calls instead of waiting out a real interval."""

    def setUp(self):
        self.conn = store.open_db(":memory:")
        self.addCleanup(self.conn.close)
        self.host = store.host_id(self.conn, "watch-test-host", "Linux")

    def _run_n_ticks(self, n):
        rows = [_healthy_row(f"2026-08-12T00:00:{i:02d}+00:00") for i in range(n)]
        sleeps = [None] * (n - 1) + [KeyboardInterrupt]
        with patch.object(watch.route_mod, "gateway", return_value="10.0.0.1"), \
             patch.object(watch.route_mod, "first_hop", return_value="203.0.113.1"), \
             patch.object(watch.probes, "sample", side_effect=rows), \
             patch.object(watch.probes, "idle_hold"), \
             patch.object(watch.environ, "wifi", return_value={"state": "unavailable"}), \
             patch.object(watch.environ, "scan",
                          return_value={"ts": "2026-08-12T00:00:00+00:00"}) as scan, \
             patch.object(watch.llmlog, "ingest", return_value=0), \
             patch.object(watch.store, "mirror", return_value={"state": "unavailable"}), \
             patch.object(watch.time, "sleep", side_effect=sleeps), \
             contextlib.redirect_stdout(io.StringIO()):
            rc = watch.run((self.conn, self.host), _args(), Path("/tmp/does-not-matter.db"))
        return rc, scan

    def test_sleep_raising_keyboardinterrupt_bounds_the_loop_to_n_samples(self):
        rc, _scan = self._run_n_ticks(4)
        self.assertEqual(rc, 0)
        self.assertEqual(len(store.samples(self.conn)), 4)

    def test_run_writes_exactly_one_env_scans_row_per_invocation(self):
        _rc, scan = self._run_n_ticks(3)
        scan.assert_called_once()
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM env_scans").fetchone()[0], 1)

    def test_startup_resolves_the_gateway_only_once(self):
        row = _healthy_row("2026-08-12T00:00:00+00:00")
        with patch.object(watch.route_mod, "gateway", return_value="10.0.0.1") as gateway, \
             patch.object(watch.route_mod, "first_hop", return_value="203.0.113.1"), \
             patch.object(watch.probes, "sample", return_value=row), \
             patch.object(watch.environ, "wifi", return_value={"state": "unavailable"}), \
             patch.object(watch.environ, "scan", return_value={"ts": row["ts"]}), \
             patch.object(watch.llmlog, "ingest", return_value=0), \
             patch.object(watch.store, "mirror", return_value={"state": "unavailable"}), \
             patch.object(watch.time, "sleep", side_effect=KeyboardInterrupt), \
             contextlib.redirect_stdout(io.StringIO()):
            watch.run((self.conn, self.host), _args(), Path("/tmp/unused.db"))
        # One startup lookup plus the first tick's deliberate re-resolution.
        self.assertEqual(gateway.call_count, 2)


class RouteReResolutionTest(unittest.TestCase):
    """CHANGELOG.md's DHCP-renewal regression: `watch` used to resolve the
    gateway once at startup and kept pinging that stale address after a
    real network change, reporting a false 'lan' outage against a network
    that had actually recovered (see also tests/test_route.py, which covers
    the ipconfig parser half of the same fix). `_tick` must re-resolve the
    gateway every call and probe the fresh gateway/hop, not a cached one."""

    def setUp(self):
        self.conn = store.open_db(":memory:")
        self.addCleanup(self.conn.close)
        self.host = store.host_id(self.conn, "watch-test-host", "Linux")

    def test_gateway_change_reresolves_hop_and_records_no_outage(self):
        row1 = _healthy_row("2026-08-12T00:00:00+00:00")
        row2 = _healthy_row("2026-08-12T00:00:20+00:00")
        with patch.object(watch.route_mod, "gateway",
                          side_effect=["10.0.0.1", "10.0.0.2"]), \
             patch.object(watch.route_mod, "first_hop",
                          return_value="203.0.113.9") as first_hop, \
             patch.object(watch.probes, "sample", side_effect=[row1, row2]) as sample, \
             patch.object(watch.probes, "idle_hold"), \
             patch.object(watch.environ, "wifi", return_value={"state": "unavailable"}), \
             patch.object(watch.llmlog, "ingest", return_value=0), \
             patch.object(watch.store, "mirror", return_value={"state": "unavailable"}), \
             contextlib.redirect_stdout(io.StringIO()):
            db = (self.conn, self.host)
            route = watch._tick(db, _args(), ("10.0.0.1", "198.51.100.1"), 1)
            route = watch._tick(db, _args(), route, 2)

        first_hop.assert_called_once_with(gateway_ip="10.0.0.2")
        self.assertEqual(route, ("10.0.0.2", "203.0.113.9"))
        sample.assert_any_call("api.anthropic.com", "10.0.0.1", "198.51.100.1",
                               wifi={"state": "unavailable"})
        sample.assert_any_call("api.anthropic.com", "10.0.0.2", "203.0.113.9",
                               wifi={"state": "unavailable"})
        self.assertEqual([r["culprit"] for r in store.samples(self.conn)], [None, None])
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0], 0)


class IdleHoldCadenceTest(unittest.TestCase):
    """Straight from watch.py: `if tick % args.idle_every == 0`. With
    idle_every=3, idle_hold must fire on tick 3 and tick 6 and nowhere
    else, and each firing's result must land as its own event row."""

    def setUp(self):
        self.conn = store.open_db(":memory:")
        self.addCleanup(self.conn.close)
        self.host = store.host_id(self.conn, "watch-test-host", "Linux")

    def test_idle_hold_fires_only_on_multiples_of_idle_every(self):
        args = _args(idle_every=3)
        held = {"state": "ok", "result": "still_alive", "held_s": 60.0}
        ticks = (1, 2, 3, 4, 5, 6)
        rows = [_healthy_row(f"2026-08-12T00:01:{i:02d}+00:00") for i in ticks]
        with patch.object(watch.route_mod, "gateway", return_value="10.0.0.1"), \
             patch.object(watch.route_mod, "first_hop", return_value="203.0.113.9"), \
             patch.object(watch.probes, "sample", side_effect=rows), \
             patch.object(watch.probes, "idle_hold", return_value=held) as idle_hold, \
             patch.object(watch.environ, "wifi", return_value={"state": "unavailable"}), \
             patch.object(watch.llmlog, "ingest", return_value=0), \
             patch.object(watch.store, "mirror", return_value={"state": "unavailable"}), \
             contextlib.redirect_stdout(io.StringIO()):
            route = ("10.0.0.1", "203.0.113.9")
            for tick in ticks:
                route = watch._tick((self.conn, self.host), args, route, tick)

        self.assertEqual(idle_hold.call_count, 2)
        idle_hold.assert_called_with(args.target, seconds=args.idle_seconds)
        events = [dict(r) for r in self.conn.execute("SELECT * FROM events ORDER BY id")]
        self.assertEqual([e["kind"] for e in events], ["idle_hold", "idle_hold"])
        self.assertEqual([json.loads(e["detail"]) for e in events], [held, held])


class MirrorCallTest(unittest.TestCase):
    """store.mirror ships unsynced rows to Supabase every tick, reading
    credentials from the environment -- the same place cmd_sync reads them
    from -- proven here with a recording fake and a patched environment."""

    def setUp(self):
        self.conn = store.open_db(":memory:")
        self.addCleanup(self.conn.close)
        self.host = store.host_id(self.conn, "watch-test-host", "Linux")

    def test_mirror_runs_every_tick_with_credentials_from_the_environment(self):
        ticks = (1, 2, 3)
        rows = [_healthy_row(f"2026-08-12T00:02:{i:02d}+00:00") for i in ticks]
        env = {"SUPABASE_URL": "https://example.test", "SUPABASE_KEY": "fixture-key"}
        with patch.object(watch.route_mod, "gateway", return_value="10.0.0.1"), \
             patch.object(watch.route_mod, "first_hop", return_value="203.0.113.9"), \
             patch.object(watch.probes, "sample", side_effect=rows), \
             patch.object(watch.probes, "idle_hold"), \
             patch.object(watch.environ, "wifi", return_value={"state": "unavailable"}), \
             patch.object(watch.llmlog, "ingest", return_value=0), \
             patch.object(watch.store, "mirror",
                          return_value={"state": "unavailable"}) as mirror, \
             patch.dict(os.environ, env, clear=False), \
             contextlib.redirect_stdout(io.StringIO()):
            route = ("10.0.0.1", "203.0.113.9")
            for tick in ticks:
                route = watch._tick((self.conn, self.host), _args(), route, tick)

        self.assertEqual(mirror.call_count, len(ticks))
        expected = (self.conn, env["SUPABASE_URL"], env["SUPABASE_KEY"], socket.gethostname())
        self.assertEqual([c.args for c in mirror.call_args_list], [expected] * len(ticks))


if __name__ == "__main__":
    unittest.main()
