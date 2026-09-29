import time
import unittest

from backend.research.independence import simhash, hamming, HAMMING_THRESHOLD
from backend.frontier.priority_frontier import ResearchFrontier


class TestSimHashPrimitive(unittest.TestCase):
    def test_identical_text_identical_signature(self):
        self.assertEqual(simhash("the quick brown fox jumps"), simhash("the quick brown fox jumps"))

    def test_case_and_whitespace_insensitive(self):
        self.assertEqual(simhash("The  Quick\nBrown Fox"), simhash("the quick brown fox"))

    def test_near_duplicate_within_threshold(self):
        a = ("The Alpha Reactor achieved a sustained output of 42 megawatts during the "
             "Boron Trial conducted in 2021 by the national laboratory team. Researchers "
             "reported that the plasma confinement remained stable for nearly twelve minutes.")
        b = ("The Alpha Reactor achieved a sustained output of 42 megawatts during the "
             "Boron Trial conducted in 2021 by the national laboratory team. Researchers "
             "said that the plasma confinement remained stable for nearly twelve minutes.")
        self.assertLessEqual(hamming(simhash(a), simhash(b)), HAMMING_THRESHOLD)

    def test_unrelated_text_far_apart(self):
        a = ("The Alpha Reactor achieved a sustained output of 42 megawatts during the "
             "Boron Trial conducted in 2021 by the national laboratory team.")
        b = ("Migratory songbirds navigate thousands of miles using the earth magnetic "
             "field and stellar cues, according to a decade-long tracking study.")
        self.assertGreater(hamming(simhash(a), simhash(b)), HAMMING_THRESHOLD)

    def test_empty_text_zero(self):
        self.assertEqual(simhash("   "), 0)


class TestFrontierRecordsSimHash(unittest.TestCase):
    def _frontier(self):
        return ResearchFrontier(max_depth=2, max_documents=10, max_per_domain=5)

    def test_accepted_document_stores_signature(self):
        f = self._frontier()
        ok = f.record_document("https://a.example/1", 100, "unique body text here about topic")
        self.assertTrue(ok)
        self.assertIn("https://a.example/1", f.content_simhashes)
        self.assertNotEqual(f.content_simhashes["https://a.example/1"], 0)

    def test_exact_duplicate_does_not_change_counters(self):
        f = self._frontier()
        f.record_document("https://a.example/1", 100, "same body")
        docs_before = f.documents_collected
        bytes_before = f.total_bytes_consumed
        dup = f.record_document("https://a.example/2", 100, "same body")
        self.assertFalse(dup)
        self.assertEqual(f.documents_collected, docs_before)
        self.assertEqual(f.total_bytes_consumed, bytes_before)

    def test_export_import_roundtrips_simhashes(self):
        f = self._frontier()
        f.record_document("https://a.example/1", 100, "unique body text")
        state = f.export_state()
        self.assertIn("content_simhashes", state)
        restored = ResearchFrontier.from_state(state)
        self.assertEqual(restored.content_simhashes, f.content_simhashes)

    def test_import_tolerates_missing_simhashes(self):
        f = self._frontier()
        f.record_document("https://a.example/1", 100, "unique body text")
        state = f.export_state()
        del state["content_simhashes"]
        restored = ResearchFrontier.from_state(state)
        self.assertEqual(restored.content_simhashes, {})


if __name__ == "__main__":
    unittest.main()
