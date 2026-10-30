"""Store: local SQLite is the source of truth and must write during an outage."""
import sqlite3
import tempfile
import unittest
from pathlib import Path

from network_checker import store


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.conn = store.open_db(Path(self.dir.name) / "t.db")
        self.host = store.host_id(self.conn, "surface", "Windows")

    def tearDown(self):
        self.conn.close()
        self.dir.cleanup()

    def test_sample_round_trips_with_no_network(self):
        """Criterion 10: a sample reaches disk and reads back identically.

        Nothing here touches the network, which is the point: the tool has to
        record the outage while the outage is happening.
        """
        row = {"ts": "2026-08-05T00:00:00Z", "gw_state": "ok", "gw_ms": 2.5,
               "inet_state": "fail", "inet_loss": 100.0, "culprit": "isp"}
        store.add_sample(self.conn, self.host, row)

        got = store.samples(self.conn)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["gw_ms"], 2.5)
        self.assertEqual(got[0]["inet_state"], "fail")
        self.assertEqual(got[0]["culprit"], "isp")

    def test_unavailable_is_not_stored_as_fail(self):
        """Criterion 9: 'we could not measure' must survive as its own state.

        Collapsing unavailable into fail would make every credential-less run
        look like a broken modem.
        """
        store.add_sample(self.conn, self.host, {
            "ts": "2026-08-05T00:00:01Z", "gw_state": "unavailable"})

        got = store.samples(self.conn)[0]
        self.assertEqual(got["gw_state"], "unavailable")
        self.assertNotEqual(got["gw_state"], "fail")

    def test_replaying_the_same_timestamp_does_not_duplicate(self):
        """Idempotent by (host, ts) so a retried sync or restart is harmless."""
        row = {"ts": "2026-08-05T00:00:02Z", "gw_state": "ok"}
        store.add_sample(self.conn, self.host, row)
        store.add_sample(self.conn, self.host, row)

        self.assertEqual(len(store.samples(self.conn)), 1)

    def test_unsynced_returns_only_unsynced_rows(self):
        store.add_sample(self.conn, self.host, {"ts": "a", "gw_state": "ok"})
        store.add_sample(self.conn, self.host, {"ts": "b", "gw_state": "ok"})

        pending = store.unsynced(self.conn, "samples")
        self.assertEqual(len(pending), 2)

        store.mark_synced(self.conn, "samples", [pending[0]["id"]])
        self.assertEqual(len(store.unsynced(self.conn, "samples")), 1)

    def test_host_id_is_stable_across_calls(self):
        again = store.host_id(self.conn, "surface", "Windows")
        self.assertEqual(self.host, again)

    def test_unknown_sample_column_is_rejected_loudly(self):
        """A typo'd probe key must fail, not vanish into a dropped column."""
        with self.assertRaises(ValueError):
            store.add_sample(self.conn, self.host,
                             {"ts": "z", "gw_typo_ms": 1.0})

    def test_label_round_trips_and_defaults_to_none(self):
        """FR-021: an experiment run's label must survive a write/read cycle,
        and an ordinary (unlabeled) sample must read back as None, never a
        fabricated tag."""
        store.add_sample(self.conn, self.host, {"ts": "t-plain", "gw_state": "ok"})
        store.add_sample(self.conn, self.host,
                         {"ts": "t-wifi", "gw_state": "ok"}, label="wifi")

        got = {r["ts"]: r for r in store.samples(self.conn)}
        self.assertIsNone(got["t-plain"]["label"])
        self.assertEqual(got["t-wifi"]["label"], "wifi")

    def test_samples_by_label_returns_only_matching_rows(self):
        store.add_sample(self.conn, self.host, {"ts": "l1", "gw_state": "ok"}, label="wifi")
        store.add_sample(self.conn, self.host, {"ts": "l2", "gw_state": "ok"}, label="ethernet")
        store.add_sample(self.conn, self.host, {"ts": "l3", "gw_state": "ok"})

        wifi = store.samples_by_label(self.conn, "wifi")
        self.assertEqual([r["ts"] for r in wifi], ["l1"])
        self.assertEqual(store.samples_by_label(self.conn, "nonexistent"), [],
                         "a label with zero stored samples must read back empty, not raise")


class SchemaMigrationTest(unittest.TestCase):
    """An existing user's on-disk database predates whatever columns get
    added to schema.sql after they first installed. executescript's
    CREATE TABLE IF NOT EXISTS is a no-op on a table that already exists, so
    without an explicit migration step those users would never receive new
    columns -- this is the upgrade path."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / "old.db"

    def _make_old_database(self):
        """A stand-in for a database created by a much earlier version of
        schema.sql: only the columns that existed before wifi/culprit/loss
        tracking was added."""
        conn = sqlite3.connect(self.path)
        conn.execute("""
            CREATE TABLE hosts (
              id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
              os TEXT NOT NULL, first_seen TEXT NOT NULL)""")
        conn.execute("""
            CREATE TABLE samples (
              id INTEGER PRIMARY KEY, host_id INTEGER NOT NULL, ts TEXT NOT NULL,
              gw_state TEXT, gw_ms REAL, synced INTEGER NOT NULL DEFAULT 0,
              UNIQUE (host_id, ts))""")
        conn.execute("INSERT INTO hosts (id, name, os, first_seen) VALUES (1, 'old-host', 'Windows', 't0')")
        conn.execute("INSERT INTO samples (host_id, ts, gw_state, gw_ms) VALUES (1, 't1', 'ok', 12.5)")
        conn.commit()
        conn.close()

    def test_missing_columns_are_added_without_losing_existing_data(self):
        self._make_old_database()

        conn = store.open_db(self.path)
        self.addCleanup(conn.close)

        current_columns = store.columns(conn, "samples")
        for expected in ("gw_loss", "wifi_signal", "wifi_bssid", "culprit", "http_code", "label"):
            self.assertIn(expected, current_columns,
                         f"schema.sql column {expected!r} was not migrated in")

        row = conn.execute("SELECT * FROM samples WHERE ts='t1'").fetchone()
        self.assertEqual(row["gw_state"], "ok")
        self.assertEqual(row["gw_ms"], 12.5)
        self.assertIsNone(row["culprit"], "new columns on old rows must be NULL, not fabricated")
        self.assertIsNone(row["label"], "an old, unlabeled row must read back label=None, "
                                        "never an inferred or fabricated tag")

    def test_migrated_database_accepts_new_writes_normally(self):
        self._make_old_database()
        conn = store.open_db(self.path)
        self.addCleanup(conn.close)
        host = store.host_id(conn, "old-host", "Windows")

        store.add_sample(conn, host, {"ts": "t2", "gw_state": "ok", "culprit": None,
                                      "wifi_signal": 80})
        got = [r for r in store.samples(conn) if r["ts"] == "t2"][0]
        self.assertEqual(got["wifi_signal"], 80)

    def test_fresh_database_is_unaffected(self):
        """No pre-existing tables to migrate -- executescript alone already
        creates the current schema in full."""
        conn = store.open_db(self.path)
        self.addCleanup(conn.close)
        self.assertIn("culprit", store.columns(conn, "samples"))


class MirrorTest(unittest.TestCase):
    """Criterion 11: pushing is idempotent and never loses local data."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.conn = store.open_db(Path(self.dir.name) / "t.db")
        self.addCleanup(self.conn.close)
        self.host = store.host_id(self.conn, "surface", "Windows")
        store.add_sample(self.conn, self.host, {"ts": "t1", "gw_state": "ok"})
        store.add_sample(self.conn, self.host, {"ts": "t2", "gw_state": "fail"})

    def _stub(self):
        """A stand-in for PostgREST that records what it was sent."""
        import json as _json
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer
        received = []

        class H(BaseHTTPRequestHandler):
            def log_message(self, *_): pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                received.append((self.path, _json.loads(body)))
                self.send_response(201)
                self.send_header("Content-Length", "0")
                self.end_headers()

        httpd = HTTPServer(("127.0.0.1", 0), H)
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        return f"http://127.0.0.1:{httpd.server_address[1]}", received

    def test_push_then_replay_sends_nothing_the_second_time(self):
        url, received = self._stub()
        first = store.mirror(self.conn, url, "key", "surface")
        self.assertEqual(first["state"], "ok")
        self.assertEqual(first["pushed"]["samples"], 2)

        second = store.mirror(self.conn, url, "key", "surface")
        self.assertEqual(second.get("pushed"), {})
        self.assertEqual(len(received), 1, "replayed an already-synced batch")

    def test_pushed_rows_carry_host_name_not_local_ids(self):
        url, received = self._stub()
        store.mirror(self.conn, url, "key", "surface")
        row = received[0][1][0]
        self.assertEqual(row["host"], "surface")
        for gone in ("id", "host_id", "synced"):
            self.assertNotIn(gone, row)

    def test_scan_payload_is_sent_as_an_object_not_a_string(self):
        store.add_scan(self.conn, self.host,
                       {"ts": "t3", "payload": '{"wifi": {"channel": 44}}'})
        url, received = self._stub()
        store.mirror(self.conn, url, "key", "surface")
        scan = next(b[0] for p, b in received
                    if p.partition("?")[0].endswith("env_scans"))
        self.assertEqual(scan["payload"], {"wifi": {"channel": 44}})

    def test_unconfigured_mirror_is_unavailable_and_marks_nothing(self):
        result = store.mirror(self.conn, None, None, "surface")
        self.assertEqual(result["state"], "unavailable")
        self.assertEqual(len(store.unsynced(self.conn, "samples")), 2)

    def test_unreachable_endpoint_leaves_rows_pending_for_retry(self):
        """The link being down is exactly when this runs. Losing the rows then
        would defeat the entire design."""
        result = store.mirror(self.conn, "http://127.0.0.1:1", "key", "surface")
        self.assertEqual(result["state"], "fail")
        self.assertEqual(len(store.unsynced(self.conn, "samples")), 2)


if __name__ == "__main__":
    unittest.main()
