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


from dataclasses import replace
from backend.research.types import Evidence
from backend.research.independence import assign_families


def _ev(url, excerpt, doi="", title=""):
    return Evidence(title=title or url, url=url, snippet="", excerpt=excerpt, doi=doi)


class TestFamilyAssignment(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(assign_families([]), ([], []))

    def test_near_duplicates_collapse_to_one_family(self):
        body = "the quick brown fox jumps over the lazy dog in autumn light again"
        alt = "the quick brown fox jumps over the lazy dog in autumn sunlight again"
        items = [_ev("https://a.example/1", body), _ev("https://b.example/2", alt),
                 _ev("https://c.example/3", body)]
        items = [replace(e, simhash=simhash(e.excerpt)) for e in items]
        annotated, families = assign_families(items)
        self.assertEqual(len({e.family_id for e in annotated}), 1)
        self.assertEqual(len(families), 1)
        self.assertEqual(families[0].size, 3)

    def test_unrelated_stay_separate(self):
        a = _ev("https://a.example/1", "semiconductor revenue rose across every node")
        b = _ev("https://b.example/2", "songbirds navigate using magnetic field cues")
        items = [replace(e, simhash=simhash(e.excerpt)) for e in (a, b)]
        annotated, families = assign_families(items)
        self.assertEqual(len(families), 2)
        self.assertEqual(len({e.family_id for e in annotated}), 2)

    def test_shared_doi_groups_even_if_text_differs(self):
        a = _ev("https://arxiv.org/x", "preprint abstract wording one", doi="10.1/x")
        b = _ev("https://journal.org/x", "published version different abstract wording", doi="10.1/x")
        items = [replace(e, simhash=simhash(e.excerpt)) for e in (a, b)]
        _, families = assign_families(items)
        self.assertEqual(len(families), 1)

    def test_representative_is_first_in_ranked_order(self):
        body = "identical body content used across syndicated copies for the test"
        items = [replace(_ev(f"https://s{i}.example/{i}", body), simhash=simhash(body)) for i in range(3)]
        annotated, families = assign_families(items)
        reps = [e for e in annotated if e.is_representative]
        self.assertEqual(len(reps), 1)
        self.assertEqual(reps[0].url, "https://s0.example/0")
        self.assertEqual(families[0].representative_url, "https://s0.example/0")

    def test_family_ids_first_appearance_order(self):
        a = _ev("https://a.example/1", "unrelated alpha content about markets")
        b = _ev("https://b.example/2", "unrelated beta content about biology")
        items = [replace(e, simhash=simhash(e.excerpt)) for e in (a, b)]
        annotated, _ = assign_families(items)
        self.assertEqual(annotated[0].family_id, 0)
        self.assertEqual(annotated[1].family_id, 1)


from backend.synthesis.claim_verifier import verify_evidence


class TestFamilyAwareVerification(unittest.TestCase):
    CLAIM = "The Alpha Reactor produced 42 megawatts during the Boron Trial in 2021."

    def _docs(self, urls):
        return [{"url": u, "excerpt": self.CLAIM} for u in urls]

    def test_same_family_repeats_are_single_source(self):
        docs = self._docs(["https://a/1", "https://b/2", "https://c/3"])
        fams = {"https://a/1": 0, "https://b/2": 0, "https://c/3": 0}
        result = verify_evidence(docs, families=fams)
        verified_claims = " ".join(c["claim"] for c in result["verified"])
        self.assertNotIn("Alpha Reactor", verified_claims)
        single = " ".join(c["claim"] for c in result["single_source"])
        self.assertIn("Alpha Reactor", single)
        self.assertGreaterEqual(result["independence"]["collapsed_claims"], 1)

    def test_two_families_corroborate(self):
        docs = self._docs(["https://a/1", "https://b/2"])
        fams = {"https://a/1": 0, "https://b/2": 1}
        result = verify_evidence(docs, families=fams)
        verified_claims = " ".join(c["claim"] for c in result["verified"])
        self.assertIn("Alpha Reactor", verified_claims)

    def test_families_none_matches_url_behavior(self):
        docs = self._docs(["https://a/1", "https://b/2"])
        result = verify_evidence(docs)  # no families -> URL-based
        verified_claims = " ".join(c["claim"] for c in result["verified"])
        self.assertIn("Alpha Reactor", verified_claims)


import os
import tempfile
from backend.synthesis.report_generator import write_report
from backend.research.preview import preview
from backend.research.types import SearchOptions


class TestReportAndPreview(unittest.TestCase):
    def test_report_none_independence_has_no_section(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "report.md")
            write_report("topic", [{"title": "T", "url": "https://a/1", "snippet": "s", "excerpt": "e"}],
                         "summary", [], output_path=out)
            text = open(out, encoding="utf-8").read()
        self.assertNotIn("## Independence", text)

    def test_report_with_independence_section_and_redaction(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "report.md")
            indep = {"families": 2, "largest_family": 3,
                     "multi": [{"title": "SECRETCO wire story", "size": 3}]}
            write_report("topic about SECRETCO", [{"title": "SECRETCO", "url": "https://a/1", "snippet": "", "excerpt": ""}],
                         "summary", ["SECRETCO"], output_path=out, independence=indep)
            text = open(out, encoding="utf-8").read()
        self.assertIn("## Independence", text)
        self.assertNotIn("SECRETCO", text)

    def test_preview_includes_independence_warning_when_verification_on(self):
        p_on = preview("topic", SearchOptions(claim_verification=True))
        p_off = preview("topic", SearchOptions(claim_verification=False))
        self.assertTrue(any("independent families" in w for w in p_on.warnings))
        self.assertFalse(any("independent families" in w for w in p_off.warnings))


if __name__ == "__main__":
    unittest.main()
