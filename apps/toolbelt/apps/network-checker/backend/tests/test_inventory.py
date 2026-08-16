"""record_inventory() maps an already-collected scan payload into
device/interface/config_item rows; config_current answers "what is this
device's value right now". Fixture uses real parsers (topology.
parse_neighbor_table, docsis.parse_docsis_status) plus field shapes from
test_wlan_probes.py/test_snmp.py/test_ssdp.py. Findings 62/63 tests split
to test_inventory_security.py (same file-budget reason)."""
import argparse
import contextlib
import io
import tempfile
import time
import unittest
from pathlib import Path

from network_checker import docsis, inventory, store, topology

from tests import fixture

TS = "2026-08-05T00:00:00+00:00"


def _neighbor_devices():
    """The five real arp_windows.txt devices, with the gateway (192.168.1.1)
    named exactly as topology.map_devices() would after an SSDP match."""
    devices = topology.parse_neighbor_table(fixture("arp_windows.txt"))
    for dev in devices:
        dev["name"] = "ASUSTeK Computer Inc. RT-AX88U" if dev["ip"] == "192.168.1.1" else None
    return devices


def fixture_payload(ts=TS):
    """Standard/deep-tier payload, real field shapes. Counts used below:
    wifi 9+driver 9+tcp 3=21 self; docsis 7+snmp 2=9 modem; router 1;
    gateway 2; topology.name 1 = config_item 34. Devices: 5 neighbor-table
    entries (one reused by gateway_id, not a 6th)+self+modem+router = 8."""
    return {
        "ts": ts,
        "topology": {"state": "ok", "devices": _neighbor_devices()},
        "gateway_id": {"state": "ok", "manufacturer": "ASUSTeK Computer Inc.",
                       "model": "RT-AX88U", "ip": "192.168.1.1"},
        "wifi": {"state": "ok", "ssid": "HomeNet_5G", "bssid": "02:00:5e:10:00:01",
                 "band": "5 GHz", "channel": 44, "signal_pct": 93, "rssi_dbm": -41,
                 "rx_mbps": 1560.0, "tx_mbps": 1733.3, "radio": "802.11ac"},
        "driver": {"state": "ok", "adapter": "Intel(R) Wi-Fi 6 AX201 160MHz",
                   "driver": "22.230.0.4", "driver_date": "2026-01-01",
                   "link": "1560 Mbps", "allow_power_off": "False",
                   "wireless_mode": "5. 802.11ax", "roaming": "Medium",
                   "transmit_power": "Highest", "preferred_band": "No Preference"},
        "tcp": {"state": "ok", "autotuning": "normal", "rss": "enabled", "ecn": "disabled"},
        "modem": docsis.parse_docsis_status(fixture("docsis_status_adv.js")),
        "modem_snmp": {"state": "ok", "sys_descr": "ASUS RT-AX88U", "sys_uptime_ticks": 123456},
        "router": {"state": "ok", "aiprotection_enabled": True},
    }


class InventoryTestCase(unittest.TestCase):
    """Shared setUp: an on-disk store (schema.sql's real DDL) and one host."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.conn = store.open_db(Path(self.dir.name) / "t.db")
        self.addCleanup(self.conn.close)
        self.host = store.host_id(self.conn, "surface", "Windows")

    def counts(self):
        c = self.conn
        return {t: c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                for t in ("device", "interface", "config_item")}


class RecordInventoryTest(InventoryTestCase):
    """NC-3.1: one device row per neighbor-table entry, plus a config_item
    per measured property, in a single pure-mapping call."""

    def test_row_counts_match_the_fixture_device_and_property_counts(self):
        got = inventory.record_inventory(self.conn, self.host, fixture_payload(), TS)
        self.assertEqual(got, {"device": 8, "interface": 1, "config_item": 34})
        self.assertEqual(self.counts(), {"device": 8, "interface": 1, "config_item": 34})

    def test_one_device_row_per_neighbor_table_entry(self):
        inventory.record_inventory(self.conn, self.host, fixture_payload(), TS)
        ips = {r["ip"] for r in self.conn.execute("SELECT ip FROM device")}
        self.assertTrue({d["ip"] for d in _neighbor_devices()} <= ips)

    def test_the_ssdp_matched_device_is_a_gateway_with_a_real_mac_and_vendor(self):
        inventory.record_inventory(self.conn, self.host, fixture_payload(), TS)
        row = self.conn.execute("SELECT * FROM device WHERE ip='192.168.1.1'").fetchone()
        self.assertEqual(row["kind"], "gateway")
        self.assertEqual(row["mac"], "aa:bb:cc:dd:ee:ff")  # normalized (Finding 63)
        self.assertEqual(row["vendor"], "ASUSTeK Computer Inc.")

    def test_self_modem_router_are_distinct_singletons(self):
        """Three separate sentinel rows, not merged -- pins _upsert_device()'s
        own IS-based lookup (UNIQUE can't dedupe a NULL/NULL pair alone)."""
        inventory.record_inventory(self.conn, self.host, fixture_payload(), TS)
        rows = {r["ip"]: r["kind"] for r in self.conn.execute(
            "SELECT ip, kind FROM device WHERE ip IN ('self', 'modem', 'router')")}
        self.assertEqual(rows, {"self": "self", "modem": "modem", "router": "gateway"})

    def test_a_device_with_no_mac_is_never_dropped(self):
        """FR-017: a Linux FAILED row (mac=None) still gets a device row."""
        payload = {"ts": TS, "topology": {"state": "ok",
                   "devices": [{"ip": "192.168.1.99", "mac": None, "name": None}]}}
        got = inventory.record_inventory(self.conn, self.host, payload, TS)
        self.assertEqual(got["device"], 2)  # the unnamed device + the 'self' singleton
        row = self.conn.execute("SELECT * FROM device WHERE ip='192.168.1.99'").fetchone()
        self.assertIsNone(row["mac"])

    def test_unavailable_and_missing_sections_contribute_nothing(self):
        """An unmeasured section must never become a fabricated config row."""
        payload = {"ts": TS, "wifi": {"state": "unavailable", "reason": "no adapter"},
                   "modem": {"state": "fail", "reason": "timeout"}}
        got = inventory.record_inventory(self.conn, self.host, payload, TS)
        self.assertEqual(got, {"device": 1, "interface": 0, "config_item": 0})

    def test_replaying_the_same_scan_is_idempotent(self):
        """The same (ts, payload) mapped twice must not double-count rows --
        every table here is unique on an (..., observed_at) tuple."""
        inventory.record_inventory(self.conn, self.host, fixture_payload(), TS)
        inventory.record_inventory(self.conn, self.host, fixture_payload(), TS)
        self.assertEqual(self.counts(), {"device": 8, "interface": 1, "config_item": 34})

    def test_a_later_scan_with_a_changed_value_appends_not_overwrites(self):
        """NC-3.3: a new observed_at for an already-seen key appends, never mutates."""
        inventory.record_inventory(self.conn, self.host, fixture_payload(), TS)
        later = dict(fixture_payload(), wifi=dict(fixture_payload()["wifi"], channel=149))
        got = inventory.record_inventory(self.conn, self.host, later, "2026-08-06T00:00:00+00:00")
        self.assertEqual(got["config_item"], 34)  # a full second observation, not a diff
        rows = self.conn.execute(
            "SELECT value FROM config_item WHERE key='wifi.channel' ORDER BY observed_at").fetchall()
        self.assertEqual([r["value"] for r in rows], ["44", "149"])

    def test_a_measured_but_partially_populated_section_never_fabricates_a_null_row(self):
        """A partial 'ok' section (manufacturer known, model not) is the only
        way to reach _add_config's `if value is None: continue` guard --
        every other test's sections are fully populated or fully gated."""
        payload = {"ts": TS, "gateway_id": {"state": "ok", "ip": "192.168.1.1",
                   "manufacturer": "ASUSTeK Computer Inc.", "model": None}}
        got = inventory.record_inventory(self.conn, self.host, payload, TS)
        self.assertEqual(got["config_item"], 1, "the None model must not become a fabricated row")
        keys = {r["key"] for r in self.conn.execute("SELECT key FROM config_item")}
        self.assertEqual(keys, {"gateway.manufacturer"})
        self.assertNotIn("gateway.model", keys)

    def test_topology_alone_assigns_gateway_kind_only_to_the_named_entry(self):
        """Isolates _map_topology's name-to-kind line from _map_gateway's own
        unconditional kind="gateway" write, which would otherwise mask it --
        fixture_payload() always puts both at the same ip. No gateway_id here."""
        payload = {"ts": TS, "topology": {"state": "ok", "devices": [
            {"ip": "192.168.1.1", "mac": "aa-bb-cc-dd-ee-ff", "name": "ASUSTeK Computer Inc. RT-AX88U"},
            {"ip": "192.168.1.50", "mac": "11-22-33-44-55-66", "name": None},
        ]}}
        inventory.record_inventory(self.conn, self.host, payload, TS)
        rows = {r["ip"]: r["kind"] for r in self.conn.execute(
            "SELECT ip, kind FROM device WHERE ip IN ('192.168.1.1', '192.168.1.50')")}
        self.assertEqual(rows, {"192.168.1.1": "gateway", "192.168.1.50": "unknown"})


class ConfigHistoryAndViewTest(InventoryTestCase):
    """NC-3.3: config_item is append-only; config_current picks the newest
    observed_at per (device, key)."""

    def test_config_current_returns_only_the_newer_value(self):
        self.conn.execute("INSERT INTO device (host_id, mac, ip, kind, first_seen, last_seen)"
                           " VALUES (?, NULL, 'self', 'self', ?, ?)", (self.host, TS, TS))
        device_id = self.conn.execute("SELECT id FROM device").fetchone()["id"]
        insert = ("INSERT INTO config_item (device_id, key, value, observed_at, source)"
                  " VALUES (?, 'wifi.channel', ?, ?, 'environ')")
        # Newer row inserted first: the view must pick by observed_at, not insertion order.
        self.conn.execute(insert, (device_id, "149", "2026-08-05T00:00:00Z"))
        self.conn.execute(insert, (device_id, "44", "2026-08-01T00:00:00Z"))

        history = self.conn.execute(
            "SELECT COUNT(*) FROM config_item WHERE device_id=?", (device_id,)).fetchone()[0]
        self.assertEqual(history, 2, "history is the point -- the table keeps both rows")

        current = [dict(r) for r in self.conn.execute(
            "SELECT * FROM config_current WHERE device_id=?", (device_id,))]
        self.assertEqual(len(current), 1)
        self.assertEqual(current[0]["value"], "149")
        self.assertEqual(current[0]["observed_at"], "2026-08-05T00:00:00Z")


class QueryHelperTest(InventoryTestCase):
    """The read side backing `network-checker inventory`'s three modes."""

    def setUp(self):
        super().setUp()
        inventory.record_inventory(self.conn, self.host, fixture_payload(), TS)
        self.gateway_id = self.conn.execute(
            "SELECT id FROM device WHERE ip='192.168.1.1'").fetchone()["id"]

    def test_devices_lists_every_recorded_device(self):
        rows = inventory.devices(self.conn)
        self.assertEqual(len(rows), 8)
        self.assertIn("last_seen", rows[0])

    def test_device_config_returns_current_values_or_empty_for_an_unknown_id(self):
        keys = {r["key"] for r in inventory.device_config(self.conn, self.gateway_id)}
        self.assertEqual(keys, {"gateway.manufacturer", "gateway.model", "topology.name"})
        self.assertEqual(inventory.device_config(self.conn, 999999), [])

    def test_changes_since_excludes_rows_at_or_before_the_cutoff(self):
        self.assertEqual(inventory.changes_since(self.conn, TS), [])
        self.assertGreater(len(inventory.changes_since(self.conn, "2026-08-01T00:00:00+00:00")), 0)

    def test_cli_default_mode_prints_one_line_per_device(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = inventory.cli(self.conn, argparse.Namespace(device=None, diff=None))
        self.assertEqual(rc, 0)
        self.assertEqual(len(out.getvalue().splitlines()), 8)


class TimedRenderTest(InventoryTestCase):
    """Inventory render shall complete under 500ms (05-f sec 8), stress-tested
    against a multi-thousand-row history -- a stand-in for a year of scans."""

    N_DEVICES, N_KEYS, N_OBSERVATIONS = 40, 15, 5  # 40*15*5 = 3000 config_item rows

    def setUp(self):
        super().setUp()
        rows = []
        for d in range(self.N_DEVICES):
            self.conn.execute(
                "INSERT INTO device (host_id, mac, ip, kind, first_seen, last_seen)"
                " VALUES (?, ?, ?, 'client', ?, ?)",
                (self.host, f"aa:bb:cc:dd:ee:{d:02x}", f"10.0.0.{d}", TS, TS))
            device_id = self.conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            rows += [(device_id, f"key.{k}", f"v{o}", f"2026-{1 + o:02d}-01T00:00:00Z", "environ")
                     for k in range(self.N_KEYS) for o in range(self.N_OBSERVATIONS)]
        self.conn.executemany(
            "INSERT INTO config_item (device_id, key, value, observed_at, source)"
            " VALUES (?, ?, ?, ?, ?)", rows)
        self.target_device = self.conn.execute("SELECT id FROM device LIMIT 1").fetchone()["id"]

    def test_device_table_and_config_queries_stay_well_under_budget(self):
        start = time.perf_counter()
        inventory.devices(self.conn)
        inventory.device_config(self.conn, self.target_device)
        inventory.changes_since(self.conn, "2026-01-01T00:00:00Z", limit=10000)
        elapsed = time.perf_counter() - start
        total_rows = self.N_DEVICES * self.N_KEYS * self.N_OBSERVATIONS
        self.assertLess(elapsed, 0.5, f"inventory queries took {elapsed:.3f}s against {total_rows} rows")


if __name__ == "__main__":
    unittest.main()
