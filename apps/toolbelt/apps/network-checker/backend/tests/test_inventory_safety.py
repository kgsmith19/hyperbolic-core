"""Inventory identity, atomicity, and optional-mirror integration."""
import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from network_checker import inventory, store
from tests.test_inventory import TS, fixture_payload


class InventorySafetyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.conn = store.open_db(Path(self.tmp.name) / "inventory.db")
        self.addCleanup(self.conn.close)
        self.host = store.host_id(self.conn, "inventory-safety", "Linux")

    def test_mac_format_and_dhcp_change_reuse_one_device_identity(self):
        first = {"topology": {"state": "ok", "devices": [
            {"ip": "192.168.1.20", "mac": "AA-BB-CC-DD-EE-FF", "name": None}]}}
        second = {"topology": {"state": "ok", "devices": [
            {"ip": "192.168.1.44", "mac": "aa:bb:cc:dd:ee:ff", "name": None}]}}
        inventory.record_inventory(self.conn, self.host, first, TS)
        inventory.record_inventory(self.conn, self.host, second, "2026-08-06T00:00:00Z")
        rows = self.conn.execute(
            "SELECT mac, ip FROM device WHERE mac IS NOT NULL").fetchall()
        self.assertEqual([tuple(row) for row in rows], [("aa:bb:cc:dd:ee:ff", "192.168.1.44")])

    def test_malformed_mac_is_not_promoted_to_a_hardware_identity(self):
        payload = {"topology": {"state": "ok", "devices": [
            {"ip": "192.168.1.30", "mac": "not-a-mac", "name": None}]}}
        inventory.record_inventory(self.conn, self.host, payload, TS)
        row = self.conn.execute(
            "SELECT mac FROM device WHERE ip='192.168.1.30'").fetchone()
        self.assertIsNone(row["mac"])

    def test_failed_mapping_rolls_back_the_whole_inventory_scan(self):
        with patch.object(inventory, "_map_modem", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                inventory.record_inventory(self.conn, self.host, fixture_payload(), TS)
        counts = [self.conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                  for table in ("device", "interface", "config_item")]
        self.assertEqual(counts, [0, 0, 0])

    def test_changed_device_or_config_resets_synced_for_retry(self):
        inventory.record_inventory(self.conn, self.host, fixture_payload(), TS)
        self.conn.execute("UPDATE device SET synced=1")
        self.conn.execute("UPDATE config_item SET synced=1")
        later = copy.deepcopy(fixture_payload())
        later["wifi"]["channel"] = 149
        inventory.record_inventory(self.conn, self.host, later, "2026-08-06T00:00:00Z")
        gateway = self.conn.execute(
            "SELECT synced FROM device WHERE ip='192.168.1.1'").fetchone()[0]
        pending = self.conn.execute(
            "SELECT COUNT(*) FROM config_item WHERE synced=0").fetchone()[0]
        self.assertEqual(gateway, 0)
        self.assertGreater(pending, 0)


class InventoryMirrorTest(unittest.TestCase):
    def test_natural_key_payloads_replace_local_device_ids(self):
        conn = store.open_db(":memory:")
        self.addCleanup(conn.close)
        host = store.host_id(conn, "mirror-host", "Linux")
        inventory.record_inventory(conn, host, fixture_payload(), TS)
        config = store.unsynced(conn, "config_item")[0]
        payload = store.for_remote(conn, "config_item", config, "mirror-host")
        self.assertEqual(payload["host"], "mirror-host")
        self.assertIn("device_ip", payload)
        self.assertIn("device_mac", payload)
        self.assertNotIn("device_id", payload)
        self.assertNotIn("id", payload)


if __name__ == "__main__":
    unittest.main()
