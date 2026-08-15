"""Upgrade and inventory-mirror safety regressions."""
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from netcheck import inventory, store
from tests.test_inventory import TS, fixture_payload


class InventoryMirrorSafetyTest(unittest.TestCase):
    def setUp(self):
        self.conn = store.open_db(":memory:")
        self.addCleanup(self.conn.close)
        self.host = store.host_id(self.conn, "mirror-safety", "Linux")
        inventory.record_inventory(self.conn, self.host, fixture_payload(), TS)

    def test_inventory_batches_use_device_upsert_and_append_only_dedup(self):
        policies = {}

        def push(_supabase, table, _rows):
            policies[table] = store._conflict_policy(table)

        with patch.object(store, "_push", side_effect=push):
            result = store.mirror(self.conn, "https://example.test", "key", "mirror-safety")
        self.assertEqual(result["state"], "ok")
        self.assertEqual(policies["device"], "merge-duplicates")
        self.assertEqual(policies["interface"], "ignore-duplicates")
        self.assertEqual(policies["config_item"], "ignore-duplicates")

    def test_failed_inventory_push_marks_no_rows_in_that_batch_synced(self):
        before = len(store.unsynced(self.conn, "device"))
        with patch.object(store, "_push", return_value="offline"):
            result = store.mirror(self.conn, "https://example.test", "key", "mirror-safety")
        self.assertEqual(result["state"], "fail")
        self.assertEqual(len(store.unsynced(self.conn, "device")), before)

    def test_mirror_fails_soft_instead_of_raising_when_a_device_lacks_mac_and_ip(self):
        # Regression for a real bug: for_remote() raises ValueError for a
        # device row with neither identifier (its own natural-key contract
        # requires one), and mirror() used to call it from inside a bare
        # list comprehension with no try/except -- watch.py's continuous
        # monitoring loop calls mirror() every tick with no surrounding
        # try/except either, so this used to crash the whole watch loop.
        # No current writer produces this shape (inventory.py always sets a
        # real address or a sentinel), so this is reached only via a
        # hand-inserted row here, exactly as a future writer or a legacy row
        # could produce it.
        self.conn.execute(
            "INSERT INTO device (host_id, kind, first_seen, last_seen, synced) "
            "VALUES (?, 'unknown', ?, ?, 0)",
            (self.host, TS, TS),
        )
        with patch.object(store, "_push") as push:
            result = store.mirror(self.conn, "https://example.test", "key", "mirror-safety")
        push.assert_not_called()
        self.assertEqual(result["state"], "fail")
        self.assertIn("MAC or IP", result["reason"])
        # Fail-soft, not fail-open: the malformed row (and every other
        # pending device row behind it) stays unsynced for retry, the same
        # contract a network failure already gets from _push().
        self.assertTrue(store.unsynced(self.conn, "device"))

    def test_every_mirrored_table_posts_against_its_natural_conflict_key(self):
        targets = {
            "samples": "host,ts",
            "events": "host,ts,kind",
            "llm_errors": "host,ts,detail",
            "env_scans": "host,ts",
            "device": "host,identity",
            "interface": "host,device_mac,device_ip,name,observed_at",
            "config_item": "host,device_mac,device_ip,key,observed_at",
        }
        response = MagicMock(status=201)
        response.__enter__.return_value = response
        with patch.object(store.urllib.request, "urlopen", return_value=response) as send:
            for table, target in targets.items():
                with self.subTest(table=table):
                    self.assertIsNone(store._push(("https://example.test", "key"), table, [{}]))
                    request = send.call_args.args[0]
                    self.assertEqual(
                        request.full_url,
                        f"https://example.test/rest/v1/{table}?on_conflict={target}",
                    )


class RemoteMigrationContractTest(unittest.TestCase):
    def test_additive_upgrade_brings_remote_sample_and_inventory_shape_current(self):
        migration = (Path(__file__).resolve().parents[1] / "supabase" / "migrations"
                     / "0003_mirror_contract.sql").read_text().lower()
        self.assertIn("alter table samples add column if not exists label text", migration)
        self.assertIn("alter table device add column if not exists identity text", migration)
        self.assertIn("both mac and ip are null", migration)
        self.assertIn("create unique index if not exists device_host_identity_key", migration)
        self.assertIn("create unique index if not exists interface_observation_key", migration)
        self.assertIn("create unique index if not exists config_item_observation_key", migration)

    def test_remote_upgrade_has_a_paired_down_migration(self):
        down = (Path(__file__).resolve().parents[1] / "supabase" / "migrations"
                / "0003_mirror_contract_down.sql")
        self.assertTrue(down.is_file())


if __name__ == "__main__":
    unittest.main()
