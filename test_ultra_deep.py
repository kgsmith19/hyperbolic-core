"""Tests for the ultra-deep upgrade set (all offline, no network).

Covers: reasoning-item output extraction (the summary bug), query
rewriting (multiquery + HyDE with mocked model), SEC EDGAR enrichment,
PDF text fallback, claim verification, and wiring of the new options
through preview / server / CLI / planner / pipeline.
"""

import os
import unittest
from unittest.mock import MagicMock, patch


class TestOutputExtraction(unittest.TestCase):
    """Reasoning-model responses must yield message text, never the blob."""

    def _response(self, output_text="", items=()):
        resp = MagicMock()
        resp.output_text = output_text
        resp.output = list(items)
        return resp

    def _msg(self, text):
        block = MagicMock()
        block.type = "output_text"
        block.text = text
        item = MagicMock()
        item.type = "message"
        item.content = [block]
        return item

    def _reasoning(self):
        item = MagicMock()
        item.type = "reasoning"
        item.content = []
        return item

    def test_plain_output_text_preferred(self):
        from backend.research.cloud_client import _extract_output_text
        resp = self._response(output_text="Brief text here.", items=[self._reasoning()])
        self.assertEqual(_extract_output_text(resp), "Brief text here.")

    def test_reasoning_blob_never_leaks(self):
        from backend.research.cloud_client import _extract_output_text
        resp = self._response(output_text="", items=[self._reasoning(), self._msg("## Executive Summary\nBody [1].")])
        out = _extract_output_text(resp)
        self.assertIn("Executive Summary", out)
        self.assertNotIn("ResponseReasoningItem", out)
        self.assertNotIn("encrypted_content", out)
        self.assertNotIn("gAAAAA", out)

    def test_empty_response_yields_empty_string(self):
        from backend.research.cloud_client import _extract_output_text
        self.assertEqual(_extract_output_text(self._response()), "")

    def test_invoke_model_uses_extractor(self):
        from backend.research.cloud_client import invoke_model
        with patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}, clear=False):
            with patch("backend.research.cloud_client.openai.OpenAI") as mock_openai:
                mock_openai.return_value.responses.create.return_value = self._response(
                    output_text="", items=[self._reasoning(), self._msg("Angle one\nAngle two")])
                out = invoke_model("prompt", model="gpt-5-mini", max_output_tokens=100)
        self.assertIn("Angle one", out)
        self.assertNotIn("ResponseReasoningItem", out)


class TestQueryRewriting(unittest.TestCase):
    def test_multiquery_local_variants(self):
        from backend.research.query_rewriter import multiquery_variants
        out = multiquery_variants("solid state battery electrolytes grid storage", [])
        self.assertGreaterEqual(len(out), 1)
        self.assertTrue(all(isinstance(q, str) and q for q in out))
        self.assertNotIn("solid state battery electrolytes grid storage", out)

    def test_multiquery_short_topic_empty(self):
        from backend.research.query_rewriter import multiquery_variants
        self.assertEqual(multiquery_variants("hi", []), [])

    def test_hyde_without_key_empty(self):
        from backend.research.query_rewriter import hyde_draft_queries
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}, clear=False):
            self.assertEqual(hyde_draft_queries("topic", []), [])

    @patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}, clear=False)
    def test_hyde_builds_queries_from_draft(self):
        from backend.research.query_rewriter import hyde_draft_queries
        client = MagicMock()
        draft = MagicMock()
        draft.output_text = ("Solid state electrolytes enable safer batteries with higher "
                             "energy density and faster charging capabilities.")
        draft.output = []
        usage = MagicMock()
        usage.input_tokens = 50
        usage.output_tokens = 30
        draft.usage = usage
        client.responses.create.return_value = draft
        with patch("backend.research.cloud_client.openai.OpenAI", return_value=client):
            out = hyde_draft_queries("solid state batteries", [], conceal_process=False)
        self.assertGreaterEqual(len(out), 1)
        self.assertTrue(all(len(q.split()) >= 5 for q in out))

    def test_planner_adds_rewrite_variants_without_key(self):
        from backend.research.planner import plan_queries
        from backend.research.types import SearchOptions
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}, clear=False):
            qs = plan_queries("solid state battery electrolytes grid storage", [],
                              SearchOptions(query_rewrite=True))
        texts = [q.text for q in qs if not q.is_decoy]
        self.assertGreaterEqual(len(texts), 2)
        off = plan_queries("solid state battery electrolytes grid storage", [],
                           SearchOptions(query_rewrite=False))
        self.assertEqual([q.text for q in off if not q.is_decoy],
                         ["solid state battery electrolytes grid storage"])


class TestSecEdgarEnriched(unittest.TestCase):
    def test_filing_urls_and_counts(self):
        from backend.retrieval.connectors.sec_edgar_connector import search_sec_edgar
        hits = [{"_id": "123-456", "_source": {"form": "10-K", "display_names": ["ACME Corp"],
                                               "ciks": ["000123"], "file_date": "2024-01-01"}}] * 3
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = {"hits": {"hits": hits}}
        with patch("backend.retrieval.connectors.sec_edgar_connector.httpx.Client") as mock_client:
            mock_client.return_value.__enter__.return_value.get.return_value = resp
            out = search_sec_edgar("acme")
        self.assertEqual(len(out), 3)
        self.assertIn("index.json", out[0]["url"])
        self.assertIn("10-K", out[0]["title"])
        self.assertIn("2024-01-01", out[0]["snippet"])


class TestPdfFallback(unittest.TestCase):
    def test_pdf_streams_extracted(self):
        from backend.retrieval.content_cleaner import _extract_pdf_text_fallback
        raw = "%PDF-1.4 BT (Deep research findings on batteries) ET BT (Grid storage data here) ET"
        out = _extract_pdf_text_fallback(raw)
        self.assertIn("Deep research findings", out)
        self.assertIn("Grid storage", out)

    def test_non_pdf_empty(self):
        from backend.retrieval.content_cleaner import _extract_pdf_text_fallback
        self.assertEqual(_extract_pdf_text_fallback("<html>hi</html>"), "")


class TestClaimVerifier(unittest.TestCase):
    def test_verified_vs_contested(self):
        from backend.synthesis.claim_verifier import verify_evidence
        ev = [
            {"url": "https://a.example", "excerpt": "Solid State Batteries achieve 400 Wh/kg capacity in 2024 testing."},
            {"url": "https://b.example", "excerpt": "Solid State Batteries achieve 400 Wh/kg capacity in 2024 testing."},
            {"url": "https://c.example", "excerpt": "Solid State Batteries cannot reach 400 Wh/kg capacity reliably."},
        ]
        out = verify_evidence(ev)
        self.assertIn("verified", out)
        self.assertIn("contested", out)
        self.assertIn("single_source", out)

    def test_brief_renders(self):
        from backend.synthesis.claim_verifier import verification_brief
        v = {"verified": [{"claim": "Batteries improved 20% in 2024.", "urls": ["https://a.example"]}],
             "contested": [{"claim": "Batteries cannot scale.", "urls": ["https://b.example"]}],
             "single_source": []}
        text = verification_brief(v)
        self.assertIn("Contested", text)
        self.assertIn("Corroborated", text)

    def test_empty_evidence(self):
        from backend.synthesis.claim_verifier import verify_evidence
        out = verify_evidence([])
        self.assertEqual(out, {"verified": [], "contested": [], "single_source": [],
                               "independence": {"families": 0, "collapsed_claims": 0}})


class TestLlmProcessHideShow(unittest.TestCase):
    """Hide and show are first-class LLM-process modes. Watchlist never leaves."""

    def test_defaults_to_hide(self):
        from backend.research.types import SearchOptions
        opts = SearchOptions()
        self.assertEqual(opts.llm_process, "hide")
        self.assertTrue(opts.conceal_process)

    def test_show_alias_from_conceal_process_false(self):
        from backend.research.types import SearchOptions
        opts = SearchOptions(conceal_process=False)
        self.assertEqual(opts.llm_process, "show")
        self.assertFalse(opts.conceal_process)

    def test_explicit_show_wins(self):
        from backend.research.types import SearchOptions
        opts = SearchOptions(llm_process="show")
        self.assertEqual(opts.llm_process, "show")
        self.assertFalse(opts.conceal_process)

    def test_explicit_hide_wins_over_alias_default(self):
        from backend.research.types import SearchOptions
        opts = SearchOptions(llm_process="hide")
        self.assertEqual(opts.llm_process, "hide")
        self.assertTrue(opts.conceal_process)

    def test_invalid_falls_back_to_hide(self):
        from backend.research.types import SearchOptions
        opts = SearchOptions(llm_process="whatever")
        self.assertEqual(opts.llm_process, "hide")
        self.assertTrue(opts.conceal_process)

    def test_planner_show_sends_bare_topic(self):
        from backend.research.planner import plan_queries
        from backend.research.types import SearchOptions
        seen = {}
        def fake_expand(topic, watchlist, model="gpt-4o-mini", reasoning_effort=None,
                        cost_tracker=None, conceal_process=True):
            seen["conceal"] = conceal_process
            seen["topic"] = topic
            return [topic, "bare angle"]
        with patch("backend.research.planner.expand_topic_queries", side_effect=fake_expand):
            qs = plan_queries("topic", [], SearchOptions(ai_planning=True, llm_process="show",
                                                         query_rewrite=False, hyde_queries=False))
        self.assertFalse(seen["conceal"])
        self.assertEqual(seen["topic"], "topic")
        self.assertEqual([q.text for q in qs if not q.is_decoy], ["topic", "bare angle"])

    def test_planner_hide_chaffs(self):
        from backend.research.planner import plan_queries
        from backend.research.types import SearchOptions
        seen = {}
        def fake_expand(topic, watchlist, model="gpt-4o-mini", reasoning_effort=None,
                        cost_tracker=None, conceal_process=True):
            seen["conceal"] = conceal_process
            return [topic, "hidden angle"]
        with patch("backend.research.planner.expand_topic_queries", side_effect=fake_expand):
            plan_queries("topic", [], SearchOptions(ai_planning=True, llm_process="hide",
                                                    query_rewrite=False, hyde_queries=False))
        self.assertTrue(seen["conceal"])

    def test_cli_llm_process_flag(self):
        import sys
        sys.path.insert(0, ".")
        from deep_search import build_options, build_parser
        hide = build_options(build_parser().parse_args([]))
        self.assertEqual(hide.llm_process, "hide")
        show = build_options(build_parser().parse_args(["--llm-process", "show"]))
        self.assertEqual(show.llm_process, "show")
        self.assertFalse(show.conceal_process)
        alias = build_options(build_parser().parse_args(["--no-conceal-process"]))
        self.assertEqual(alias.llm_process, "show")

    def test_server_parses_llm_process(self):
        from backend.server.web_server import _options_from_payload
        self.assertEqual(_options_from_payload({}).llm_process, "hide")
        self.assertEqual(_options_from_payload({"llm_process": "show"}).llm_process, "show")
        self.assertEqual(_options_from_payload({"conceal_process": False}).llm_process, "show")

    def test_preview_show_does_not_say_chaffed(self):
        from backend.research.preview import preview
        from backend.research.types import SearchOptions
        show = preview("t", SearchOptions(ai_planning=True, llm_process="show"))
        self.assertTrue(any("topic leaves the machine" in w.lower() for w in show.warnings))
        self.assertFalse(any("chaffed" in w.lower() for w in show.warnings))
        hide = preview("t", SearchOptions(ai_planning=True, llm_process="hide"))
        self.assertTrue(any("chaffed" in w.lower() for w in hide.warnings))


class TestDeepWebRouterAndSynthesis(unittest.TestCase):
    """New public connectors remain selectable and participate in all-search."""

    def test_deep_web_connectors_are_selectable_and_aggregated(self):
        from backend.retrieval.retrieval_router import RetrievalRouter

        router = RetrievalRouter()
        connector_results = {
            "search_openalex": [{"source": "openalex"}],
            "search_arxiv": [{"source": "arxiv"}],
            "search_crossref": [{"source": "crossref"}],
            "search_sec_edgar": [{"source": "sec"}],
            "search_searxng": [{"source": "searxng"}],
            "search_brave": [{"source": "brave"}],
            "search_pubmed": [{"source": "pubmed_pmc"}],
            "search_wikipedia": [{"source": "wikipedia"}],
            "search_hackernews": [{"source": "hackernews"}],
        }
        handlers = {
            name: (lambda _query, result=result: result)
            for name, result in connector_results.items()
        }
        with patch.multiple(router, **handlers):
            self.assertEqual(router.search("topic", connector="pubmed"), connector_results["search_pubmed"])
            self.assertEqual(router.search("topic", connector="wikipedia"), connector_results["search_wikipedia"])
            self.assertEqual(router.search("topic", connector="hackernews"), connector_results["search_hackernews"])
            sources = {item["source"] for item in router.search("topic")}

        self.assertEqual(sources, {
            "openalex", "arxiv", "crossref", "sec", "searxng", "brave",
            "pubmed_pmc", "wikipedia", "hackernews",
        })

    def test_synthesis_formats_top_twenty_five_evidence_sources(self):
        from backend.synthesis.openai_synthesizer import _format_sources

        evidence = [
            {"title": f"Source {number}", "url": f"https://example.com/{number}", "excerpt": "safe"}
            for number in range(1, 27)
        ]
        formatted = _format_sources(evidence, [])

        self.assertIn("Source [25]:", formatted)
        self.assertNotIn("Source [26]:", formatted)


class TestUltraDeepWiring(unittest.TestCase):
    def test_preview_declares_new_options(self):
        from backend.research.preview import preview
        from backend.research.types import SearchOptions
        p = preview("t", SearchOptions(ai_planning=True))
        joined = " ".join(p.warnings).lower()
        self.assertIn("variants", joined)
        self.assertIn("hyde", joined)
        self.assertIn("cross-checked", joined)
        off = preview("t", SearchOptions(query_rewrite=False, hyde_queries=False,
                                         claim_verification=False))
        self.assertNotIn("hyde", " ".join(off.warnings).lower())

    def test_server_parses_new_options(self):
        from backend.server.web_server import _options_from_payload
        self.assertTrue(_options_from_payload({}).query_rewrite)
        self.assertTrue(_options_from_payload({}).claim_verification)
        self.assertFalse(_options_from_payload({"query_rewrite": False}).query_rewrite)
        self.assertFalse(_options_from_payload({"hyde_queries": False}).hyde_queries)

    def test_cli_flags_flip_new_options(self):
        import sys
        sys.path.insert(0, ".")
        from deep_search import build_options, build_parser
        self.assertTrue(build_options(build_parser().parse_args([])).hyde_queries)
        opts = build_options(build_parser().parse_args(["--no-rewrite", "--no-hyde", "--no-verify"]))
        self.assertFalse(opts.query_rewrite)
        self.assertFalse(opts.hyde_queries)
        self.assertFalse(opts.claim_verification)

    def test_synthesis_accepts_verification(self):
        from backend.synthesis.openai_synthesizer import summarize_with_openai
        client = MagicMock()
        resp = MagicMock()
        resp.output_text = "## Executive Summary\nBody [1]."
        resp.output = []
        usage = MagicMock()
        usage.input_tokens = 100
        usage.output_tokens = 20
        resp.usage = usage
        client.responses.create.return_value = resp
        with patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}, clear=False):
            with patch("backend.research.cloud_client.openai.OpenAI", return_value=client) as mock_openai:
                out = summarize_with_openai(
                    "topic", [{"title": "T", "url": "https://e.com", "excerpt": "text"}],
                    [], verification={"verified": [{"claim": "X improved.", "urls": ["https://e.com"]}],
                                      "contested": [], "single_source": []})
        prompt = mock_openai.return_value.responses.create.call_args.kwargs["input"]
        self.assertIn("cross-source claim check", prompt)
        self.assertIn("Executive Summary", out)


if __name__ == "__main__":
    unittest.main()
