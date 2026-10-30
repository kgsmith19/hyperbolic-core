"""Proves the backup and restore drill fails loudly when it should (#504, AC2)."""

import json
import sys
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import store_ops


def make_db(path, rows):
    conn = sqlite3.connect(path)
    conn.execute("create table item (id integer primary key, body text)")
    conn.executemany("insert into item (body) values (?)", [(r,) for r in rows])
    conn.commit()
    conn.close()


class StoreOpsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.db = self.tmp / "live.db"
        make_db(self.db, ["a", "b", "c"])
        self.stores = [{"app": "demo", "file": "unused.db", "env": "DEMO_DB"}]
        self.env = {"DEMO_DB": str(self.db)}

    def test_backup_then_drill_proves_the_snapshot_and_reports_rpo_rto(self):
        out = self.tmp / "backup"
        manifest = store_ops.backup(out, self.stores, self.env)
        self.assertEqual(manifest["stores"][0]["rows"], {"item": 3})
        report = store_ops.restore_drill(out, now=datetime.now(timezone.utc) + timedelta(seconds=90))
        self.assertEqual(report["restored"], [{"app": "demo", "rows": 3}])
        self.assertGreaterEqual(report["rpo_seconds"], 90)
        self.assertGreaterEqual(report["rto_seconds"], 0)

    def test_drill_refuses_a_snapshot_changed_after_backup(self):
        out = self.tmp / "backup"
        store_ops.backup(out, self.stores, self.env)
        with sqlite3.connect(out / "demo.db") as conn:
            conn.execute("delete from item")
        with self.assertRaisesRegex(RuntimeError, "hash does not match"):
            store_ops.restore_drill(out)

    def test_drill_refuses_when_the_manifest_row_counts_are_wrong(self):
        out = self.tmp / "backup"
        store_ops.backup(out, self.stores, self.env)
        manifest_path = out / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["stores"][0]["rows"] = {"item": 99}
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError, "row counts differ"):
            store_ops.restore_drill(out)

    def test_a_store_without_a_file_is_skipped_not_invented(self):
        out = self.tmp / "backup"
        manifest = store_ops.backup(out, [{"app": "absent", "file": "x.db", "env": "NOPE"}], {})
        self.assertEqual(manifest["stores"], [])
        self.assertEqual(manifest["skipped"], ["absent"])
        with self.assertRaisesRegex(RuntimeError, "no stores"):
            store_ops.restore_drill(out)

    def test_env_override_is_what_gets_backed_up(self):
        other = self.tmp / "other.db"
        make_db(other, ["x"])
        out = self.tmp / "backup"
        manifest = store_ops.backup(out, self.stores, {"DEMO_DB": str(other)})
        self.assertEqual(manifest["stores"][0]["rows"], {"item": 1})

    def test_backup_then_drill_preserves_nested_attachment_bytes(self):
        blobs = self.tmp / "blobs"
        nested = blobs / "sha256" / "ab"
        nested.mkdir(parents=True)
        payload = nested / "abcdef"
        payload.write_bytes(b"document bytes")
        stores = [{
            **self.stores[0],
            "attachments": [{"name": "blobs", "file": "unused-blobs", "env": "DEMO_BLOB_ROOT"}],
        }]
        out = self.tmp / "backup"
        manifest = store_ops.backup(out, stores, {**self.env, "DEMO_BLOB_ROOT": str(blobs)})
        self.assertEqual(manifest["attachments"], [{
            "app": "demo",
            "name": "blobs",
            "root": "demo-blobs",
            "files": [{
                "path": "sha256/ab/abcdef",
                "sha256": store_ops.sha256(payload),
                "bytes": len(b"document bytes"),
            }],
        }])
        self.assertTrue((out / "demo-blobs" / "sha256" / "ab" / "abcdef").is_file())
        report = store_ops.restore_drill(out)
        self.assertEqual(report["restored_attachments"], [{"app": "demo", "name": "blobs", "files": 1}])

    def test_drill_refuses_an_attachment_changed_after_backup(self):
        blobs = self.tmp / "blobs"
        blobs.mkdir()
        payload = blobs / "document"
        payload.write_bytes(b"original")
        stores = [{
            **self.stores[0],
            "attachments": [{"name": "blobs", "file": "unused-blobs", "env": "DEMO_BLOB_ROOT"}],
        }]
        out = self.tmp / "backup"
        store_ops.backup(out, stores, {**self.env, "DEMO_BLOB_ROOT": str(blobs)})
        (out / "demo-blobs" / "document").write_bytes(b"changed")
        with self.assertRaisesRegex(RuntimeError, "attachment hash does not match"):
            store_ops.restore_drill(out)

    def test_missing_attachment_is_skipped_not_invented(self):
        stores = [{
            **self.stores[0],
            "attachments": [{"name": "blobs", "file": "missing", "env": "DEMO_BLOB_ROOT"}],
        }]
        manifest = store_ops.backup(self.tmp / "backup", stores, self.env)
        self.assertEqual(manifest["attachments"], [])
        self.assertEqual(manifest["skipped_attachments"], ["demo:blobs"])

    def test_drill_refuses_an_attachment_path_escaping_restore_root(self):
        blobs = self.tmp / "blobs"
        blobs.mkdir()
        (blobs / "document").write_bytes(b"safe")
        stores = [{
            **self.stores[0],
            "attachments": [{"name": "blobs", "file": "unused-blobs", "env": "DEMO_BLOB_ROOT"}],
        }]
        out = self.tmp / "backup"
        store_ops.backup(out, stores, {**self.env, "DEMO_BLOB_ROOT": str(blobs)})
        manifest_path = out / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["attachments"][0]["files"][0]["path"] = "../escape"
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError, "escapes attachment root"):
            store_ops.restore_drill(out)


if __name__ == "__main__":
    unittest.main()
