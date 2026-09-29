"""Offline contracts for durable, privacy-safe research-run persistence."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.research.types import Evidence, SearchOptions
from backend.research.run_store import RunStore, RunStoreError
from backend.frontier.priority_frontier import ResearchFrontier
from backend.research.information_gain import InformationGainTracker

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


class TestInformationGain(unittest.TestCase):
    def test_stops_only_after_configured_consecutive_low_gain_batches(self):
        frontier = ResearchFrontier()
        tracker = InformationGainTracker(consecutive_round_limit=2)
        tracker.observe_batch([Evidence(title="A", url="https://a.example/1", snippet="first", excerpt="first unique body")], frontier)
        self.assertFalse(tracker.should_stop(minimum_documents=2))
        tracker.observe_batch([], frontier)
        self.assertFalse(tracker.should_stop(minimum_documents=1))
        tracker.observe_batch([], frontier)
        self.assertTrue(tracker.should_stop(minimum_documents=1))

    def test_new_domain_doi_or_content_resets_low_gain_streak(self):
        frontier = ResearchFrontier()
        tracker = InformationGainTracker(consecutive_round_limit=2)
        tracker.observe_batch([], frontier)
        tracker.observe_batch([Evidence(title="A", url="https://a.example/1", snippet="one", doi="10.1/a", excerpt="one")], frontier)
        self.assertFalse(tracker.should_stop(minimum_documents=0))
        tracker.observe_batch([], frontier)
        tracker.observe_batch([Evidence(title="B", url="https://b.example/1", snippet="two", excerpt="two")], frontier)
        self.assertFalse(tracker.should_stop(minimum_documents=0))

    def test_zero_threshold_never_stops(self):
        tracker = InformationGainTracker(consecutive_round_limit=0)
        tracker.observe_batch([], ResearchFrontier())
        self.assertFalse(tracker.should_stop(minimum_documents=0))


class TestDurablePipeline(unittest.TestCase):
    def test_pipeline_persists_additive_run_metadata(self):
        from backend.research.research_pipeline import run_search
        from backend.research.types import Query
        options = SearchOptions(max_gap_rounds=0, citation_expansion=False, rerank_results=False)
        with tempfile.TemporaryDirectory() as root, \
             patch("backend.research.research_pipeline.prepare_topic", return_value="topic"), \
             patch("backend.research.research_pipeline.plan_queries", return_value=[Query("topic")]), \
             patch("backend.research.research_pipeline.explore", return_value=[]), \
             patch("backend.research.research_pipeline.rank_items", return_value=[]), \
             patch("backend.research.research_pipeline.write_report", return_value="reports/test.md"):
            run = run_search("topic", [], options, run_id="durable-1", ledger_root=root)
            manifest = json.loads(Path(root, "durable-1", "manifest.json").read_text())
        self.assertEqual(run.run_id, "durable-1")
        self.assertEqual(run.stop_reason, "completed")
        self.assertEqual(manifest["status"], "success")

    def test_pipeline_passes_all_ranked_evidence_to_synthesis(self):
        from backend.research.research_pipeline import run_search
        from backend.research.types import Query
        evidence = [Evidence(title=str(i), url=f"https://e{i}.org", snippet="s", excerpt="safe") for i in range(12)]
        options = SearchOptions(max_gap_rounds=0, citation_expansion=False, rerank_results=False)
        with patch("backend.research.research_pipeline.prepare_topic", return_value="topic"), \
             patch("backend.research.research_pipeline.plan_queries", return_value=[Query("topic")]), \
             patch("backend.research.research_pipeline.explore", return_value=evidence), \
             patch("backend.research.research_pipeline.rank_items", return_value=evidence), \
             patch("backend.research.research_pipeline._synthesize", return_value="brief") as synthesize, \
             patch("backend.research.research_pipeline.write_report", return_value="reports/test.md"):
            run_search("topic", [], options)
        self.assertEqual(len(synthesize.call_args.args[1]), 12)


if __name__ == "__main__":
    unittest.main()
