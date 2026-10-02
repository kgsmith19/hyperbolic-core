"""Tests for real-key cloud paths: planning, gap analysis, structured briefs, key check.

All OpenAI interactions are mocked; no test in this file touches the network.
"""

import os
import re
import unittest
from unittest.mock import MagicMock, patch

from backend.research.cloud_client import check_openai_key
from backend.research.cost_estimator import CostTracker, MODEL_PRICING
from backend.research.explorer import _bm25_priorities
from backend.research.query_planner import expand_topic_queries, propose_gap_queries
from backend.research.types import SearchOptions
from backend.synthesis.openai_synthesizer import (
    MAX_EXCERPT_CHARS,
    summarize_with_openai,
)
from backend.privacy.watchlist_redactor import SafetyError


def _mock_response(output_text: str, p_tokens: int = 11, c_tokens: int = 7):
    resp = MagicMock()
    resp.output_text = output_text
    usage = MagicMock()
    usage.input_tokens = p_tokens
    usage.prompt_tokens = p_tokens
    usage.output_tokens = c_tokens
    usage.completion_tokens = c_tokens
    resp.usage = usage
    return resp


WATCHLIST = ["CONFIDENTIAL-PROJECT-ORION"]


@patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}, clear=False)
class TestExpandTopicQueriesConcealed(unittest.TestCase):
    """Default path: the real topic hides inside a chaffed multi-topic prompt."""

    def test_concealed_by_default_real_topic_buried(self):
        client = MagicMock()
        client.responses.create.return_value = _mock_response(
            "Topic 1:\n- decoy query one\n- decoy query two\n\n"
            "Topic 2:\n- real angle one\n- real angle two\n\n"
            "Topic 3:\n- other angle one\n- other angle two\n"
        )
        with patch("backend.research.cloud_client.openai.OpenAI", return_value=client) as mock_openai:
            with patch("backend.privacy.statistical_chaffer.generate_chaffed_prompt") as mock_gen:
                # Force: real topic buried as Topic 2 of 3.
                mock_gen.return_value = (
                    "Topic 1: decoy alpha\nTopic 2: solid state batteries\nTopic 3: decoy beta", 2
                )
                queries = expand_topic_queries("solid state batteries", [])
        kwargs = mock_openai.return_value.responses.create.call_args.kwargs
        prompt = kwargs["input"]
        # Concealment: prompt carries decoy topics around the real one.
        self.assertIn("solid state batteries", prompt)
        self.assertIn("Topic 1:", prompt)
        self.assertIn("Topic 3:", prompt)
        # Extraction: only the real block (Topic 2) is parsed; decoy blocks dropped.
        self.assertEqual(queries[0], "solid state batteries")
        self.assertIn("real angle one", queries)
        self.assertIn("real angle two", queries)
        self.assertTrue(all("decoy query" not in q for q in queries))
        self.assertTrue(all("other angle" not in q for q in queries))
        # Bigger allowance: chaffed prompt spans k topics.
        self.assertGreaterEqual(kwargs.get("max_output_tokens", 0), 800)

    def test_concealed_output_never_names_real_topic(self):
        """Only the real block is extracted; extracted queries never embed the raw topic."""
        client = MagicMock()
        client.responses.create.return_value = _mock_response(
            "Topic 1:\n- ventral fin study\n\nTopic 2:\n- yield analysis\n- defect screening\n"
        )
        with patch("backend.research.cloud_client.openai.OpenAI", return_value=client):
            with patch("backend.privacy.statistical_chaffer.generate_chaffed_prompt") as mock_gen:
                # Force: real topic is Topic 2 of 2, so only its block is extracted.
                mock_gen.return_value = ("Topic 1: decoy\nTopic 2: mystery topic xyz", 2)
                queries = expand_topic_queries("mystery topic xyz", [])
        self.assertEqual(queries[0], "mystery topic xyz")
        self.assertIn("yield analysis", queries)
        self.assertIn("defect screening", queries)
        self.assertNotIn("ventral fin study", queries)
        for q in queries[1:]:
            # No extracted query may embed the raw topic text (that would leak the process).
            self.assertNotIn("mystery topic xyz", q)

    def test_concealed_failure_raises_cloud_call_error(self):
        with patch(
            "backend.research.cloud_client.openai.OpenAI",
            side_effect=RuntimeError("down"),
        ):
            from backend.research.cloud_errors import CloudCallError
            with self.assertRaises(CloudCallError):
                expand_topic_queries("topic", [])


@patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}, clear=False)
class TestExpandTopicQueries(unittest.TestCase):
    def _patched_client(self, output_text: str):
        mock_client = MagicMock()
        mock_client.responses.create.return_value = _mock_response(output_text)
        return mock_client

    def test_bare_expansion_tracks_cost_and_expands(self):
        tracker = CostTracker(max_spend_usd=10.0)
        client = self._patched_client("angle one\n2. angle two\nangle one")
        with patch("backend.research.cloud_client.openai.OpenAI", return_value=client) as mock_openai:
            queries = expand_topic_queries(
                "solid state batteries", WATCHLIST, cost_tracker=tracker, conceal_process=False
            )
        kwargs = mock_openai.return_value.responses.create.call_args.kwargs
        self.assertEqual(kwargs["model"], "gpt-4o-mini")
        self.assertIn("solid state batteries", kwargs["input"])
        # Topic first, both clean angles kept, duplicates dropped
        self.assertEqual(queries, ["solid state batteries", "angle one", "angle two"])
        report = tracker.get_report()
        self.assertEqual(report.prompt_tokens, 11)
        self.assertEqual(report.completion_tokens, 7)
        self.assertGreater(report.estimated_cost_usd, 0.0)

    def test_reasoning_effort_passed_for_reasoning_models(self):
        client = self._patched_client("angle")
        with patch("backend.research.cloud_client.openai.OpenAI", return_value=client) as mock_openai:
            expand_topic_queries("topic", [], model="o4-mini", reasoning_effort="high", conceal_process=False)
        kwargs = mock_openai.return_value.responses.create.call_args.kwargs
        self.assertEqual(kwargs.get("reasoning"), {"effort": "high"})

    def test_no_key_returns_topic_only(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}, clear=False):
            queries = expand_topic_queries("topic only", WATCHLIST)
        self.assertEqual(queries, ["topic only"])

    def test_conceal_flag_routes_planner_to_bare_or_chaffed(self):
        from backend.research.planner import plan_queries

        seen = {}

        def fake_expand(topic, watchlist, model="gpt-4o-mini", reasoning_effort=None,
                        cost_tracker=None, conceal_process=True):
            seen["conceal"] = conceal_process
            return [topic, "angle"]

        with patch("backend.research.planner.expand_topic_queries", side_effect=fake_expand):
            qs = plan_queries("topic", [], SearchOptions(ai_planning=True, conceal_process=False))
            self.assertFalse(seen["conceal"])
            self.assertEqual([q.text for q in qs if not q.is_decoy], ["topic", "angle"])

            qs2 = plan_queries("topic", [], SearchOptions(ai_planning=True, conceal_process=True))
            self.assertTrue(seen["conceal"])
            self.assertEqual([q.text for q in qs2 if not q.is_decoy], ["topic", "angle"])


@patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}, clear=False)
class TestProposeGapQueries(unittest.TestCase):
    def test_sends_redacted_snippets_and_parses_queries(self):
        client = MagicMock()
        client.responses.create.return_value = _mock_response(
            "thermal runaway standards\ncost per kWh trend"
        )
        evidence = [
            {
                "title": "Battery Safety Survey",
                "url": "https://example.com/a",
                "excerpt": "Coverage of thermal runaway. " * 20 + " CONFIDENTIAL-PROJECT-ORION",
            }
        ]
        tracker = CostTracker(max_spend_usd=10.0)
        with patch("backend.research.cloud_client.openai.OpenAI", return_value=client) as mock_openai:
            queries = propose_gap_queries(
                "grid storage", WATCHLIST, evidence, cost_tracker=tracker,
                conceal_process=False,
            )
        prompt = mock_openai.return_value.responses.create.call_args.kwargs["input"]
        self.assertIn("Battery Safety Survey", prompt)
        self.assertIn("grid storage", prompt)
        self.assertNotIn("CONFIDENTIAL-PROJECT-ORION", prompt)
        self.assertNotIn("CONFIDENTIAL-PROJECT-ORION", " ".join(queries))
        self.assertEqual(queries, ["thermal runaway standards", "cost per kWh trend"])

    def test_without_key_returns_empty(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}, clear=False):
            self.assertEqual(propose_gap_queries("t", WATCHLIST, []), [])

    def test_hide_mode_chaffs_gap_prompt(self):
        client = MagicMock()
        client.responses.create.return_value = _mock_response(
            "Topic 1:\n- ocean vents\n\nTopic 2:\n- missing angle one\n- missing angle two\n\nTopic 3:\n- drones\n"
        )
        with patch("backend.research.cloud_client.openai.OpenAI", return_value=client) as mock_openai:
            queries = propose_gap_queries(
                "grid storage", [], [{"title": "A", "excerpt": "storage paper"}],
                conceal_process=True,
            )
        prompt = mock_openai.return_value.responses.create.call_args.kwargs["input"]
        self.assertIn("Topic 1:", prompt)
        self.assertIn("Topic 2: grid storage", prompt)
        self.assertIn("Topic 3:", prompt)
        self.assertIn("missing angle one", queries)
        self.assertNotIn("ocean vents", queries)


@patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}, clear=False)
class TestStructuredSummary(unittest.TestCase):
    def test_prompt_is_structured_cited_and_capped(self):
        client = MagicMock()
        client.responses.create.return_value = _mock_response(
            "## Executive Summary\nBrief [1].\n## Key Findings\n- point [1]\n"
        )
        evidence = [
            {
                "title": f"Source {i}",
                "url": f"https://example.com/{i}",
                "excerpt": "x" * 5000,
            }
            for i in range(1, 11)
        ]
        tracker = CostTracker(max_spend_usd=10.0)
        with patch("backend.research.cloud_client.openai.OpenAI", return_value=client) as mock_openai:
            summary = summarize_with_openai("topic", evidence, [], cost_tracker=tracker)
        kwargs = mock_openai.return_value.responses.create.call_args.kwargs
        prompt = kwargs["input"]
        self.assertIn("## Key Findings", prompt)
        self.assertIn("[1]", prompt)
        self.assertIn("Never invent a source", prompt)
        # Fewer than MAX_SOURCES sources are all included.
        self.assertIn("Source [10]:", prompt)
        self.assertNotIn("Source [11]:", prompt)
        # Per-source excerpt capped
        self.assertNotIn("x" * (MAX_EXCERPT_CHARS + 1), prompt)
        self.assertIn("## Executive Summary", summary)

    def test_secret_in_evidence_blocked_before_it_reaches_the_model(self):
        evidence = [{"title": "t", "url": "https://example.com", "excerpt": "CONFIDENTIAL-PROJECT-ORION leak"}]
        with patch("backend.research.cloud_client.openai.OpenAI") as mock_openai:
            with self.assertRaises(SafetyError):
                summarize_with_openai("topic", evidence, WATCHLIST)
            mock_openai.assert_not_called()

    def test_output_redacted_before_return(self):
        client = MagicMock()
        client.responses.create.return_value = _mock_response("found CONFIDENTIAL-PROJECT-ORION in filings")
        with patch("backend.research.cloud_client.openai.OpenAI", return_value=client):
            summary = summarize_with_openai("topic", [{"title": "t", "url": "https://e.com", "excerpt": "safe"}], WATCHLIST)
        self.assertNotIn("CONFIDENTIAL-PROJECT-ORION", summary)
        self.assertIn("[REDACTED:local-watchlist-match]", summary)


class TestKeyCheck(unittest.TestCase):
    def test_check_openai_key_contract(self):
        client = MagicMock()
        client.responses.create.return_value = _mock_response("ready", p_tokens=9, c_tokens=2)
        with patch("backend.research.cloud_client.openai.OpenAI", return_value=client) as mock_openai:
            report = check_openai_key(model="gpt-4o-mini")
        kwargs = mock_openai.return_value.responses.create.call_args.kwargs
        self.assertEqual(kwargs["input"], "Reply with the single word: ready")
        self.assertEqual(kwargs["model"], "gpt-4o-mini")
        self.assertTrue(report["ok"])
        self.assertEqual(report["prompt_tokens"], 9)
        self.assertEqual(report["completion_tokens"], 2)
        self.assertGreaterEqual(report["estimated_cost_usd"], 0.0)


class TestLiveApiKey(unittest.TestCase):
    """Real-key smoke tests: opt-in via DEEPSEARCH_LIVE=1, skipped otherwise.

    These are the only tests that touch the network. They use the key from
    the local .env (loaded via load_env_file) and spend fractions of a cent:
    one minimal key check plus one concealed planning call. Run with:

        DEEPSEARCH_LIVE=1 python -m unittest test_ai_search_expansion.TestLiveApiKey -v
    """

    def _live_key(self):
        from backend.server import load_env_file
        from backend.research.cloud_client import get_api_key
        load_env_file()
        return get_api_key()

    def test_live_key_check_replies_ready(self):
        if os.environ.get("DEEPSEARCH_LIVE") != "1":
            self.skipTest("set DEEPSEARCH_LIVE=1 to run live-key tests")
        key = self._live_key()
        if not key:
            self.skipTest("no OPENAI_API_KEY in .env")
        report = check_openai_key(model="gpt-4o-mini")
        self.assertTrue(report["ok"])
        self.assertEqual(report["model"], "gpt-4o-mini")
        self.assertIn("ready", report["output_text"].lower())
        self.assertGreater(report["prompt_tokens"], 0)
        print(f"\nlive key check: {report['prompt_tokens']} in / "
              f"{report['completion_tokens']} out (~${report['estimated_cost_usd']:.6f})")

    def test_live_concealed_planning_returns_real_angles(self):
        if os.environ.get("DEEPSEARCH_LIVE") != "1":
            self.skipTest("set DEEPSEARCH_LIVE=1 to run live-key tests")
        if not self._live_key():
            self.skipTest("no OPENAI_API_KEY in .env")
        from backend.research.cost_estimator import CostTracker
        tracker = CostTracker(model="gpt-4o-mini", max_spend_usd=1.00)
        queries = expand_topic_queries(
            "solid-state battery electrolytes", [], cost_tracker=tracker
        )
        # Concealed default: topic first plus extracted real-block angles.
        # Angles legitimately restate topic words (they are about the topic);
        # concealment means the *prompt* hid which of 8 topics was real and
        # the response carries Topic-N structure, not a bare-topic answer.
        self.assertEqual(queries[0], "solid-state battery electrolytes")
        self.assertGreaterEqual(len(queries), 2)
        for q in queries[1:]:
            self.assertTrue(len(q) > 10)
            self.assertNotEqual(q, queries[0])
        report = tracker.get_report()
        self.assertGreater(report.total_tokens, 0)
        print(f"\nlive concealed planning: {queries[1:]}\n"
              f"spend ~${report.estimated_cost_usd:.6f} "
              f"({report.total_tokens} tokens)")


class TestPricing(unittest.TestCase):
    def test_o4_mini_has_own_pricing(self):
        tracker = CostTracker(model="o4-mini", max_spend_usd=100.0)
        cost = tracker.estimate_cost(prompt_tokens=1_000_000)
        self.assertAlmostEqual(cost, 1.10)

    def test_unknown_model_falls_back_to_4o_mini_rates(self):
        tracker = CostTracker(model="gpt-99-unknown", max_spend_usd=100.0)
        cost = tracker.estimate_cost(prompt_tokens=1_000_000)
        self.assertAlmostEqual(cost, 0.15)


class TestRelevancePriorities(unittest.TestCase):
    def test_bm25_priorities_in_range_and_ordered(self):
        results = [
            {"title": "solid state battery electrolyte", "snippet": "electrolyte degradation"},
            {"title": "cooking recipes", "snippet": "delicious pasta"},
        ]
        prios = _bm25_priorities("solid state battery electrolyte degradation", results)
        self.assertEqual(len(prios), 2)
        for p in prios:
            self.assertGreaterEqual(p, 30.0)
            self.assertLessEqual(p, 60.0)
        self.assertGreater(prios[0], prios[1])


@patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}, clear=False)
class TestConcealProcessToggle(unittest.TestCase):
    """Both paths work: concealed (opt-in privacy layer) and shown (default). Preview reflects it."""

    def test_preview_states_concealment(self):
        from backend.research.preview import preview

        concealed = preview("t", SearchOptions(ai_planning=True, conceal_process=True))
        self.assertTrue(any("chaffed" in w.lower() for w in concealed.warnings))
        bare = preview("t", SearchOptions(ai_planning=True, conceal_process=False))
        self.assertTrue(any("topic leaves the machine" in w.lower() for w in bare.warnings))
        self.assertFalse(any("chaffed" in w.lower() for w in bare.warnings))

    def test_server_parses_conceal_process(self):
        from backend.server.web_server import _options_from_payload

        # Privacy is an opt-in layer: the default shows the process to the model.
        self.assertFalse(_options_from_payload({}).conceal_process)
        self.assertTrue(_options_from_payload({"conceal_process": True}).conceal_process)
        self.assertFalse(_options_from_payload({"conceal_process": False}).conceal_process)

    def test_cli_flag_flips_conceal_process(self):
        import sys
        sys.path.insert(0, ".")
        from deep_search import build_options, build_parser

        args = build_parser().parse_args([])
        self.assertFalse(build_options(args).conceal_process)
        args = build_parser().parse_args(["--llm-process", "hide"])
        self.assertTrue(build_options(args).conceal_process)
        args = build_parser().parse_args(["--no-conceal-process"])
        self.assertFalse(build_options(args).conceal_process)


@patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}, clear=False)
class TestContinuationRounds(unittest.TestCase):
    """Gap rounds continue while evidence arrives; later rounds stay local."""

    def test_zero_rounds_disables_gap_seeding(self):
        from backend.research.explorer import explore
        from backend.research.types import Query

        mock_collector = MagicMock()
        mock_collector.send_task.side_effect = [
            {
                "status": "ok",
                "results": [
                    {"title": "A", "url": "https://example.com/a"},
                    {"title": "B", "url": "https://example.com/b"},
                ],
            },
            {"status": "ok", "content": "Findings on electrolytes and stability. " * 4, "links": [], "bytes": 400},
            {"status": "ok", "content": "Review of grid storage economics. " * 4, "links": [], "bytes": 400},
        ]
        with patch("backend.research.query_planner.propose_gap_queries") as mock_gap:
            evidence = explore(
                [Query(text="topic")],
                [],
                SearchOptions(max_depth=1, max_documents=10, concurrency=1,
                              ai_planning=True, max_gap_rounds=0),
                collector=mock_collector,
            )
        mock_gap.assert_not_called()
        self.assertEqual(len(evidence), 2)
        # Only the seed search + 2 fetches; no gap search issued.
        self.assertEqual(mock_collector.send_task.call_count, 3)

    def test_round_two_and_beyond_are_local_only(self):
        from backend.research.explorer import _propose_gaps
        from backend.research.types import Evidence

        collected = [Evidence(title="t", url="https://example.com/a", snippet="s",
                              excerpt="Findings on electrolytes. " * 10)]
        with patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}, clear=False):
            with patch("backend.research.query_planner.propose_gap_queries") as mock_gap:
                self.assertEqual(
                    _propose_gaps("topic", [], SearchOptions(ai_planning=True),
                                  collected, None, None, gap_round=1), mock_gap.return_value)
                mock_gap.assert_called_once()
                out = _propose_gaps("topic", [], SearchOptions(ai_planning=True),
                                      collected, None, None, gap_round=2)
                self.assertEqual(out, [])
                mock_gap.assert_called_once()  # no second model call

    def test_model_alias_routes_both_roles(self):
        from backend.research.types import SearchOptions

        both = SearchOptions(model="gpt-4o")
        self.assertEqual(both.concealer_model, "gpt-4o")
        self.assertEqual(both.deep_model, "gpt-4o")
        explicit = SearchOptions(model="gpt-4o", concealer_model="gpt-4o-mini")
        self.assertEqual(explicit.concealer_model, "gpt-4o-mini")
        self.assertEqual(explicit.deep_model, "gpt-4o")
        legacy = SearchOptions(model="o3-mini")
        self.assertEqual(legacy.concealer_model, "o3-mini")
        self.assertEqual(legacy.deep_model, "o3-mini")


@patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}, clear=False)
class TestExplorerModelGapIntegration(unittest.TestCase):
    def test_gap_queries_routed_through_collector(self):
        from backend.research.explorer import explore
        from backend.research.types import Query

        # Protocol-agnostic fake collector: every search returns a unique hit,
        # every fetch returns readable content. The engine may issue extra
        # local follow-up searches (leads, coverage) without exhausting a list.
        mock_collector = MagicMock()
        counter = {"n": 0}

        def respond(task, watchlist):
            if task.get("action") == "search":
                q = task["query"]
                if q == "grid storage economics":
                    return {"status": "ok", "results": [
                        {"title": "Electrolyte Study", "url": "https://example.com/a"},
                        {"title": "Grid Storage Review", "url": "https://example.com/b"},
                    ]}
                counter["n"] += 1
                slug = re.sub(r"[^a-z0-9]+", "-", q.lower())
                return {"status": "ok", "results": [{"title": q, "url": f"https://example.com/{slug}-{counter['n']}"}]}
            if task.get("action") == "fetch":
                return {"status": "ok", "content": f"Grid storage economics material for {task['url']}. " * 4,
                        "links": [], "bytes": 400}
            return {"status": "ok", "results": []}

        mock_collector.send_task.side_effect = respond

        with patch(
            "backend.research.query_planner.propose_gap_queries",
            return_value=["cost per kWh projections 2030"],
        ) as mock_gap:
            evidence = explore(
                [Query(text="grid storage economics")],
                [],
                SearchOptions(max_depth=1, max_documents=10, concurrency=1, ai_planning=True),
                collector=mock_collector,
            )

        # Round 1 consults the model exactly once; later rounds stay local.
        mock_gap.assert_called_once()
        # Seed search + 2 fetches + gap searches + gap fetches (plus slack)
        self.assertGreaterEqual(mock_collector.send_task.call_count, 5)
        gap_queries_seen = [
            call.args[0]["query"]
            for call in mock_collector.send_task.call_args_list
            if call.args[0].get("action") == "search"
        ]
        self.assertIn("cost per kWh projections 2030", gap_queries_seen)
        self.assertGreaterEqual(len(evidence), 3)


if __name__ == "__main__":
    unittest.main()
