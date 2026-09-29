"""Offline contracts for durable, privacy-safe research-run persistence."""

import json
from pathlib import Path
import tempfile
import unittest

from backend.research.types import Evidence, SearchOptions
from backend.research.run_store import RunStore, RunStoreError
from backend.frontier.priority_frontier import ResearchFrontier

FAKE_SECRET = "LEDGER-SECRET-721"
WATCHLIST = [FAKE_SECRET]


class TestRunStore(unittest.TestCase):
    def test_create_writes_a_sanitized_versioned_manifest_and_ordered_events(self):
        with tempfile.TemporaryDirectory() as root:
            store = RunStore(root)
            checkpoint = store.create("run-1", f"Research {FAKE_SECRET}", SearchOptions(), WATCHLIST)
            store.checkpoint("planned", {"queries": [f"{FAKE_SECRET} review"]}, WATCHLIST)
            manifest = json.loads(Path(checkpoint.ledger_path, "manifest.json").read_text())
            events = [json.loads(line) for line in Path(checkpoint.ledger_path, "events.jsonl").read_text().splitlines()]
        self.assertEqual(manifest["schema_version"], 1)
        self.assertEqual(manifest["phase"], "planned")
        self.assertNotIn(FAKE_SECRET, json.dumps([manifest, events]))
        self.assertEqual([event["sequence"] for event in events], list(range(1, len(events) + 1)))

    def test_append_evidence_redacts_before_persistence(self):
        with tempfile.TemporaryDirectory() as root:
            store = RunStore(root)
            checkpoint = store.create("run-2", "topic", SearchOptions(), WATCHLIST)
            store.append_evidence(Evidence(title=FAKE_SECRET, url="https://example.org/1", snippet="safe", excerpt=FAKE_SECRET), WATCHLIST)
            text = Path(checkpoint.ledger_path, "evidence.jsonl").read_text()
        self.assertNotIn(FAKE_SECRET, text)
        self.assertIn("[REDACTED:local-watchlist-match]", text)

    def test_load_ignores_only_malformed_final_event(self):
        with tempfile.TemporaryDirectory() as root:
            store = RunStore(root)
            checkpoint = store.create("run-3", "topic", SearchOptions(), [])
            events = Path(checkpoint.ledger_path, "events.jsonl")
            events.write_text(events.read_text() + '{"truncated"')
            loaded = store.load("run-3", [])
        self.assertEqual(loaded["manifest"]["run_id"], "run-3")
        self.assertTrue(loaded["events"])

    def test_load_rejects_bad_manifest_and_schema(self):
        with tempfile.TemporaryDirectory() as root:
            store = RunStore(root)
            checkpoint = store.create("run-4", "topic", SearchOptions(), [])
            manifest = Path(checkpoint.ledger_path, "manifest.json")
            manifest.write_text("not json")
            with self.assertRaisesRegex(RunStoreError, "manifest"):
                store.load("run-4", [])
            manifest.write_text(json.dumps({"schema_version": 999}))
            with self.assertRaisesRegex(RunStoreError, "schema"):
                store.load("run-4", [])

    def test_finish_writes_one_terminal_event_and_validates_pair(self):
        with tempfile.TemporaryDirectory() as root:
            store = RunStore(root)
            checkpoint = store.create("run-5", "topic", SearchOptions(), [])
            store.finish("cancelled", "cancelled", [])
            events = [json.loads(line) for line in Path(checkpoint.ledger_path, "events.jsonl").read_text().splitlines()]
            self.assertEqual(sum(event["kind"] == "finished" for event in events), 1)
            with self.assertRaises(ValueError):
                store.finish("success", "cancelled", [])


class TestFrontierPersistence(unittest.TestCase):
    def test_snapshot_requeues_stale_work_once_and_preserves_bounds(self):
        frontier = ResearchFrontier(max_depth=2, max_documents=4, max_per_domain=2)
        frontier.add_candidate("https://accepted.example/a", doi="10.1/accepted", priority=90)
        frontier.add_candidate("https://inflight.example/a", doi="10.1/inflight", priority=80)
        frontier.add_candidate("https://queued.example/a", priority=70)
        accepted, stale = frontier.pop_next_batch(2)
        self.assertTrue(frontier.record_document(accepted.url, 10, "accepted unique", accepted.doi))
        existing_hash = next(iter(frontier.content_hashes))
        restored = ResearchFrontier.from_state(frontier.export_state())
        self.assertEqual(restored.in_flight_urls, set())
        batch = restored.pop_next_batch(2)
        self.assertEqual([item.url for item in batch], [stale.url, "https://queued.example/a"])
        self.assertEqual(restored.documents_collected, 1)
        self.assertIn(existing_hash, restored.content_hashes)
        self.assertFalse(restored.add_candidate(accepted.url, priority=99))
        self.assertFalse(restored.add_candidate("https://new.example/a", doi="10.1/accepted", priority=99))

    def test_rejects_incomplete_snapshot(self):
        with self.assertRaises(ValueError):
            ResearchFrontier.from_state({"version": 1})


if __name__ == "__main__":
    unittest.main()
