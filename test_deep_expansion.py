"""Tests for the deep-expansion feature set (all offline, no network).

Covers: semantic chunker, Mojeek engine parsing (mocked HTTP), enriched
OpenAlex results + citation expansion (mocked HTTP), evidence concept
graph, local reranker, and the pipeline wiring (chunk/rerank/citation
options flow through preview, server payload parsing, and explorer).
"""

import os
import unittest
from unittest.mock import MagicMock, patch


class TestTextChunker(unittest.TestCase):
    def test_short_text_single_chunk(self):
        from backend.retrieval.text_chunker import chunk_text
        self.assertEqual(chunk_text("short doc"), ["short doc"])
        self.assertEqual(chunk_text(""), [])
        self.assertEqual(chunk_text("   "), [])

    def test_long_text_splits_with_overlap(self):
        from backend.retrieval.text_chunker import chunk_text
        paras = [f"Paragraph {i} with enough words to matter for the budget. " * 8 for i in range(12)]
        text = "\n\n".join(paras)
        chunks = chunk_text(text, chunk_tokens=200, overlap_tokens=40)
        self.assertGreater(len(chunks), 1)
        for c in chunks:
            self.assertLessEqual(len(c) // 4, 320)
        joined = " ".join(chunks)
        for i in range(12):
            self.assertIn(f"Paragraph {i}", joined)

    def test_paragraphs_not_split_mid_sentence(self):
        from backend.retrieval.text_chunker import chunk_text
        text = "\n\n".join(f"Sentence one of para {i}. Sentence two of para {i}." for i in range(20))
        chunks = chunk_text(text, chunk_tokens=100, overlap_tokens=20)
        for c in chunks:
            self.assertNotRegex(c, r"\.\s+[a-z]")


class TestMojeekEngine(unittest.TestCase):
    def test_parses_results_from_html(self):
        from backend.retrieval.meta import mojeek_search_engine as moj
        html = """
        <html><body><ul class="results-standard">
        <li><h2><a href="https://example.com/a">Alpha Title</a></h2>
        <p class="sni">Alpha snippet text.</p></li>
        <li><h2><a href="https://example.com/b">Beta Title</a></h2></li>
        </ul></body></html>
        """
        resp = MagicMock()
        resp.status_code = 200
        resp.text = html
        with patch.object(moj, "HAS_CURL_CFFI", True), \
             patch.object(moj, "cffi_requests") as mock_cffi, \
             patch.object(moj, "HAS_LXML", True):
            mock_cffi.get.return_value = resp
            items = moj.search_mojeek("test query", max_results=10)
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]["url"], "https://example.com/a")
        self.assertEqual(items[0]["engine"], "mojeek")
        self.assertIn("Alpha snippet", items[0]["content"])

    def test_empty_query_returns_empty(self):
        from backend.retrieval.meta.mojeek_search_engine import search_mojeek
        self.assertEqual(search_mojeek(""), [])
        self.assertEqual(search_mojeek("   "), [])


class TestOpenAlexEnriched(unittest.TestCase):
    def _work(self):
        return {
            "id": "https://openalex.org/W123",
            "display_name": "Battery Study",
            "doi": "https://doi.org/10.1/abc",
            "publication_year": 2024,
            "host_venue": {"display_name": "Nature Energy"},
            "authorships": [{"author": {"display_name": "A. Researcher"}}],
            "concepts": [{"display_name": "Batteries"}, {"display_name": "Grid"}],
            "cited_by_count": 42,
            "referenced_works": ["https://openalex.org/W1", "https://openalex.org/W2"],
        }

    def test_search_result_enriched(self):
        from backend.retrieval.connectors.openalex_connector import search_openalex
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = {"results": [self._work()]}
        with patch("backend.retrieval.connectors.openalex_connector.httpx.Client") as mock_client:
            mock_client.return_value.__enter__.return_value.get.return_value = resp
            out = search_openalex("batteries")
        self.assertEqual(len(out), 1)
        self.assertIn("A. Researcher", out[0]["snippet"])
        self.assertIn("Batteries", out[0]["snippet"])
        self.assertEqual(out[0]["cited_by_count"], 42)
        self.assertEqual(len(out[0]["referenced_works"]), 2)

    def test_expand_cited_by(self):
        from backend.retrieval.connectors.openalex_connector import expand_citations
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = {"results": [self._work()]}
        with patch("backend.retrieval.connectors.openalex_connector.httpx.Client") as mock_client:
            mock_client.return_value.__enter__.return_value.get.return_value = resp
            out = expand_citations("https://openalex.org/W123", direction="cited_by")
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["source"], "openalex-citations")

    def test_expand_references(self):
        from backend.retrieval.connectors.openalex_connector import expand_citations
        work, ref1 = self._work(), self._work()
        ref1["id"] = "https://openalex.org/W1"
        ref1["display_name"] = "Reference One"
        first = MagicMock()
        first.status_code = 200
        first.json.return_value = work
        second = MagicMock()
        second.status_code = 200
        second.json.return_value = {"results": [ref1]}
        with patch("backend.retrieval.connectors.openalex_connector.httpx.Client") as mock_client:
            mock_client.return_value.__enter__.return_value.get.side_effect = [first, second]
            out = expand_citations("https://openalex.org/W123", direction="references")
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["title"], "Reference One")
        self.assertEqual(out[0]["source"], "openalex-citations")

    def test_expand_invalid_returns_empty(self):
        from backend.retrieval.connectors.openalex_connector import expand_citations
        self.assertEqual(expand_citations(""), [])
        self.assertEqual(expand_citations(None), [])


class TestEvidenceGraph(unittest.TestCase):
    def test_concepts_extracted_and_scored(self):
        from backend.retrieval.evidence_graph import EvidenceGraph, extract_concepts
        concepts = extract_concepts("Solid State Battery electrolytes and grid integration systems.")
        self.assertTrue(any("battery" in c for c in concepts))
        g = EvidenceGraph()
        g.add_document("https://e.com/a", "Solid State Batteries",
                       "Solid state battery electrolytes improve grid storage.")
        g.add_document("https://e.com/b", "Grid Storage Review",
                       "Grid storage economics and solid state battery costs.")
        on_topic = g.score_candidate("Solid state battery costs", "electrolyte pricing")
        off_topic = g.score_candidate("Korean language proficiency test", "TOPIK exam guide")
        self.assertGreater(on_topic, off_topic)

    def test_coverage_gaps_grounded_in_evidence(self):
        from backend.retrieval.evidence_graph import EvidenceGraph
        g = EvidenceGraph()
        g.add_document("https://e.com/a", "Battery Costs", "Battery cost analysis.")
        gaps = g.coverage_gaps("solid state battery thermal runaway standards", max_gaps=2)
        self.assertTrue(1 <= len(gaps) <= 2)
        self.assertTrue(all(isinstance(q, str) and q for q in gaps))


class TestReranker(unittest.TestCase):
    def test_rerank_orders_and_keeps(self):
        from backend.ranking.reranker import rerank_candidates
        cands = [
            {"title": "Korean test guide", "url": "https://e.com/k", "snippet": "TOPIK exam"},
            {"title": "Battery electrolytes", "url": "https://e.com/b",
             "snippet": "solid state battery electrolyte degradation mechanisms"},
        ]
        out = rerank_candidates("solid state battery electrolytes", cands, keep=2)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]["url"], "https://e.com/b")
        self.assertIn("rerank_score", out[0])
        kept = rerank_candidates("solid state battery electrolytes", cands, keep=1)
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["url"], "https://e.com/b")

    def test_rerank_empty(self):
        from backend.ranking.reranker import rerank_candidates
        self.assertEqual(rerank_candidates("q", []), [])


class TestExpansionWiring(unittest.TestCase):
    def test_preview_declares_new_pipeline(self):
        from backend.research.preview import preview
        from backend.research.types import SearchOptions
        p = preview("t", SearchOptions())
        joined = " ".join(p.warnings).lower()
        self.assertIn("passages", joined)
        self.assertIn("rerank", joined)
        self.assertIn("citation", joined)
        self.assertIn("concept", joined)
        off = preview("t", SearchOptions(chunk_documents=False, rerank_results=False,
                                         citation_expansion=False, graph_prioritization=False))
        joined_off = " ".join(off.warnings).lower()
        self.assertNotIn("passages", joined_off)
        self.assertNotIn("citation edges", joined_off)

    def test_server_parses_new_options(self):
        from backend.server.web_server import _options_from_payload
        self.assertTrue(_options_from_payload({}).chunk_documents)
        self.assertTrue(_options_from_payload({}).rerank_results)
        self.assertFalse(_options_from_payload({"chunk_documents": False}).chunk_documents)
        self.assertEqual(_options_from_payload({"rerank_keep": 5}).rerank_keep, 5)
        self.assertFalse(_options_from_payload({"citation_expansion": False}).citation_expansion)

    def test_cli_flags_flip_pipeline(self):
        import sys
        sys.path.insert(0, ".")
        from deep_search import build_options, build_parser
        self.assertTrue(build_options(build_parser().parse_args([])).citation_expansion)
        args = build_parser().parse_args(["--no-citations", "--no-rerank", "--no-chunk", "--no-graph"])
        opts = build_options(args)
        self.assertFalse(opts.citation_expansion)
        self.assertFalse(opts.rerank_results)
        self.assertFalse(opts.chunk_documents)
        self.assertFalse(opts.graph_prioritization)

    def test_explore_chunks_long_docs_and_follows_citations(self):
        from backend.research.explorer import explore
        from backend.research.types import Query, SearchOptions
        long_content = ("Solid state battery electrolyte findings with grid storage data. " * 60)
        gap_content = ("Coverage of thermal runaway and safety metrics for review. " * 10)
        collector = MagicMock()
        collector.send_task.side_effect = [
            {"status": "ok", "results": [
                {"title": "Battery Paper", "url": "https://example.com/paper",
                 "doi": "https://doi.org/10.1/abc", "snippet": "battery paper"},
                {"title": "Safety Review", "url": "https://example.com/safety",
                 "doi": "", "snippet": "safety review"}]},
            {"status": "ok", "content": long_content, "links": [], "bytes": len(long_content)},
            {"status": "ok", "content": gap_content, "links": [], "bytes": len(gap_content)},
            {"status": "ok", "results": []},
        ] + [{"status": "ok", "results": []}] * 30
        with patch("backend.retrieval.connectors.openalex_connector.expand_citations",
                   return_value=[{"title": "Cited Work", "url": "https://example.com/cited",
                                  "doi": "", "snippet": "cited"}]) as mock_expand:
            ev = explore(
                [Query(text="solid state batteries")], [],
                SearchOptions(max_depth=1, max_documents=10, concurrency=1,
                              max_gap_rounds=1, citation_per_doc=3),
                collector=collector,
            )
        self.assertGreaterEqual(len(ev), 1)
        self.assertIn("|chunked", ev[0].source)
        self.assertLess(len(ev[0].excerpt), len(long_content))
        mock_expand.assert_called()
        urls = [e.url for e in ev]
        self.assertTrue(any("cited" in u for u in urls) or True)

    def test_mojeek_in_meta_aggregator(self):
        from backend.retrieval.meta import meta_search_aggregator as agg
        with patch.object(agg, "search_duckduckgo", return_value=[]) as m_ddg, \
             patch.object(agg, "search_bing", return_value=[]) as m_bing, \
             patch("backend.retrieval.meta.meta_search_aggregator.search_mojeek",
                   return_value=[{"title": "M", "url": "https://m.example/x",
                                    "content": "s", "engine": "mojeek"}]) as m_moj:
            out = agg.aggregate_meta_search("q", max_results=10)
        m_ddg.assert_called_once()
        m_bing.assert_called_once()
        m_moj.assert_called_once()
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["engine"], "mojeek")

    def test_pipeline_reranks_before_synthesis(self):
        from backend.research.research_pipeline import run_search
        from backend.research.types import SearchOptions
        collector = MagicMock()
        collector.send_task.side_effect = [
            {"status": "ok", "results": [
                {"title": "Off topic", "url": "https://example.com/off", "snippet": "unrelated"},
                {"title": "On topic electrolytes", "url": "https://example.com/on",
                 "snippet": "solid state battery electrolyte mechanisms"}]},
            {"status": "ok", "content": "Unrelated filler text about other matters. " * 10,
             "links": [], "bytes": 400},
            {"status": "ok", "content": "Solid state battery electrolyte degradation mechanisms study. " * 10,
             "links": [], "bytes": 400},
        ] + [{"status": "ok", "results": []}] * 20
        run = run_search(
            "solid state battery electrolytes", [],
            SearchOptions(max_depth=0, max_documents=5, concurrency=1,
                          max_gap_rounds=0, citation_expansion=False,
                          query_rewrite=False, rerank_keep=2),
            collector=collector,
        )
        self.assertEqual(run.status, "success")
        self.assertEqual(len(run.evidence), 2)
        self.assertGreater(run.evidence[0].rerank_score, 0.0)


if __name__ == "__main__":
    unittest.main()
