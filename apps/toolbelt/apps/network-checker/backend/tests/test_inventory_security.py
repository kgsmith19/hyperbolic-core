"""Findings 62/63 regression tests (independent security review):
_upsert_device()'s synced=0 reset on update (62), MAC normalization's
device-dedup effect and record_inventory()'s transactional atomicity (63).
Split out of test_inventory.py for the same file-budget reason
test_change_key.py etc. are already split out of test_change.py."""
import unittest
from unittest.mock import patch

from network_checker import inventory, store, topology

from tests.test_inventory import TS, InventoryTestCase, fixture_payload


# Same on-disk store and one host as the inventory suite -- inherited rather
# than restated, which is what the duplicated copy's own docstring claimed it
# was doing.
InventorySecurityTestCase = InventoryTestCase


class SyncedResetOnUpdateTest(InventorySecurityTestCase):
    """Finding 62: _upsert_device()'s UPDATE branch must reset synced=0 so
    an already-mirrored device's later changes are queued for re-sync
    instead of never reaching Supabase again."""

    def test_updating_an_already_synced_device_resets_synced_to_zero(self):
        fact = {"mac": "aa:bb:cc:dd:ee:ff", "ip": "192.168.1.5",
                "kind": "client", "ts": TS}
        device_id = inventory._upsert_device(self.conn, self.host, fact)
        self.conn.execute("UPDATE device SET synced=1 WHERE id=?", (device_id,))
        synced = self.conn.execute(
            "SELECT synced FROM device WHERE id=?", (device_id,)).fetchone()["synced"]
        self.assertEqual(synced, 1, "precondition: simulating an already-mirrored device")

        later = dict(fact, ts="2026-08-06T00:00:00+00:00")
        same_id = inventory._upsert_device(self.conn, self.host, later)
        self.assertEqual(same_id, device_id, "must update the same row, not insert a new one")
        synced = self.conn.execute(
            "SELECT synced FROM device WHERE id=?", (device_id,)).fetchone()["synced"]
        self.assertEqual(synced, 0)


class MacNormalizationDedupeTest(InventorySecurityTestCase):
    """Finding 63: _upsert_device() matches strictly on (host_id, mac, ip),
    so this only stays one device if topology.parse_neighbor_table()
    normalizes the MAC before storing -- proves the same physical device
    reported once hyphenated/uppercase and once colon-separated/lowercase
    upserts to ONE row, not two."""

    def test_two_case_and_separator_variants_of_one_mac_map_to_one_device(self):
        first = topology.parse_neighbor_table(
            "192.168.1.9            AA-BB-CC-DD-EE-FF     dynamic\n")
        second = topology.parse_neighbor_table(
            "192.168.1.9 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE\n")
        payload1 = {"ts": TS, "topology": {"state": "ok", "devices": first}}
        payload2 = {"ts": "2026-08-06T00:00:00+00:00",
                   "topology": {"state": "ok", "devices": second}}
        inventory.record_inventory(self.conn, self.host, payload1, TS)
        inventory.record_inventory(
            self.conn, self.host, payload2, "2026-08-06T00:00:00+00:00")
        rows = self.conn.execute(
            "SELECT COUNT(*) c, MAX(mac) mac FROM device WHERE ip='192.168.1.9'").fetchone()
        self.assertEqual(rows["c"], 1)
        self.assertEqual(rows["mac"], "aa:bb:cc:dd:ee:ff")


class RecordInventoryTransactionTest(InventorySecurityTestCase):
    """Finding 63: record_inventory()'s _map_* calls now share one
    store.transaction() -- store.open_db() uses isolation_level=None (real
    autocommit), so without this a mid-call exception used to leave
    whichever calls already ran permanently committed."""

    def test_a_mid_scan_exception_leaves_the_database_completely_unchanged(self):
        before = self.counts()
        self.assertEqual(before, {"device": 0, "interface": 0, "config_item": 0})
        # _map_topology/_map_gateway (both write real rows) run BEFORE
        # _map_self in record_inventory()'s own call order, so this proves
        # the transaction rolls back writes that already happened this
        # call, not merely ones that were about to happen.
        with patch.object(inventory, "_map_self", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                inventory.record_inventory(self.conn, self.host, fixture_payload(), TS)
        self.assertEqual(self.counts(), before)


if __name__ == "__main__":
    unittest.main()
