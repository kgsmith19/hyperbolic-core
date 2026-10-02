"""Unit Tests for Direct Domain Bounded Context Imports.

Verifies that each bounded context package in `backend/` functions independently
with clear interfaces and invariant preservation.
"""

import argparse
import os
import unittest
from unittest.mock import MagicMock, patch

from backend.privacy import (
    enforce_secret_core_socket_block,
    SafetyError,
    redact,
    assert_safe_to_send,
    create_blinder,
    blind_text,
    rehydrate_text,
    StatisticalChaffer,
    calculate_shannon_entropy,
    SecureZeroBuffer,
    EphemeralEncryptedScratch,
    SanitizedQuarantine,
)
from backend.frontier import (
    FrontierItem,
    ResearchFrontier,
    canonicalize_url,
)
from backend.ranking import (
    compute_bm25_scores,
    compute_dense_scores,
    reciprocal_rank_fusion,
    rank_items,
)
from backend.retrieval.meta import (
    decode_bing_url,
    is_port_in_use,
)
from backend.retrieval import (
    is_safe_url,
    is_bot_or_js_barrier,
    extract_clean_content,
    validate_task_schema,
)
from backend.synthesis import (
    LocalSynthesizer,
    write_report,
)
from backend.research import (
    expand_topic_queries,
)
from backend.research.cost_estimator import (
    CostTracker,
    SpendLimitExceededError,
)
from backend.research.cancellation import (
    cancellation_manager,
    CancellationToken,
)
from backend.server import (
    load_lines,
    load_env_file,
)


class TestDirectBoundedContexts(unittest.TestCase):
    """Test suite for direct bounded context package usage."""

    def test_security_guard_context(self):
        secret = "CLASSIFIED-ALPHA-99"
        watchlist = [secret]

        # Redaction & assertion
        self.assertEqual(redact(f"Project {secret} details", watchlist), "Project [REDACTED:local-watchlist-match] details")
        with self.assertRaises(SafetyError):
            assert_safe_to_send(f"Query {secret}", watchlist)

        # Blinder
        f_map, r_map = create_blinder(watchlist)
        blinded = blind_text(f"Query {secret}", f_map)
        self.assertIn("[TARGET_ENTITY_1]", blinded)
        self.assertNotIn(secret, blinded)
        rehydrated = rehydrate_text(blinded, r_map)
        self.assertEqual(rehydrated, f"Query {secret}")

        # Secure zero buffer
        with SecureZeroBuffer("Sensitive In-Memory Token") as buf:
            self.assertEqual(buf.read_text(), "Sensitive In-Memory Token")

        # Ephemeral encrypted scratch
        with EphemeralEncryptedScratch() as scratch:
            scratch.store("doc1", "Secret Content")
            self.assertEqual(scratch.retrieve("doc1"), "Secret Content")

        # Statistical chaffer
        chaffer = StatisticalChaffer(seed=42)
        decoys = chaffer.generate_decoys("Solid-state lithium batteries", k=3)
        self.assertEqual(len(decoys), 3)
        self.assertGreater(calculate_shannon_entropy("Solid-state lithium batteries"), 2.0)

    def test_discovery_frontier_context(self):
        clean = canonicalize_url("https://example.org/paper?ref=123#abstract")
        self.assertEqual(clean, "https://example.org/paper")

        frontier = ResearchFrontier(max_depth=2, max_documents=5)
        added = frontier.add_candidate("https://example.org/paper", priority=75.0)
        self.assertTrue(added)
        self.assertEqual(len(frontier.queue), 1)

        batch = frontier.pop_next_batch(batch_size=1)
        self.assertEqual(len(batch), 1)
        self.assertEqual(batch[0].url, "https://example.org/paper")

        # Record doc & hash deduplication
        is_new = frontier.record_document("https://example.org/paper", 1000, "Paper content body")
        self.assertTrue(is_new)
        is_duplicate = frontier.record_document("https://example.org/mirror", 1000, "Paper content body")
        self.assertFalse(is_duplicate)

    def test_relevance_ranking_context(self):
        corpus = [
            "Solid-state lithium battery electrolytes with high ionic conductivity",
            "Superconducting quantum circuits and qubit coherence times",
            "Polymer separators in electric vehicle energy storage",
        ]
        query = "solid-state lithium conductivity"

        bm25 = compute_bm25_scores(query, corpus)
        self.assertEqual(len(bm25), 3)
        self.assertGreater(bm25[0], bm25[1])

        dense = compute_dense_scores(query, corpus)
        self.assertEqual(len(dense), 3)

        rrf = reciprocal_rank_fusion([bm25, dense])
        self.assertEqual(len(rrf), 3)
        self.assertEqual(max(rrf), rrf[0])

        items = [{"title": f"Doc {i}", "content": text} for i, text in enumerate(corpus)]
        ranked = rank_items(query, items)
        self.assertEqual(ranked[0]["content"], corpus[0])

    def test_meta_search_context(self):
        # Bing redirect decoder
        import base64
        test_url = "https://www.nature.com/articles/battery"
        b64 = base64.urlsafe_b64encode(test_url.encode("utf-8")).decode("utf-8")
        bing_url = f"https://www.bing.com/ck/a?!&&p=abc&u=a1{b64}&ntb=1"
        self.assertEqual(decode_bing_url(bing_url), test_url)

    def test_retrieval_engine_context(self):
        # SSRF checks
        self.assertTrue(is_safe_url("https://arxiv.org/abs/2301.00001"))
        self.assertFalse(is_safe_url("http://127.0.0.1:8765"))
        self.assertFalse(is_safe_url("http://169.254.169.254/latest/meta-data/"))

        # Bot barrier check
        self.assertTrue(is_bot_or_js_barrier("Attention Required! | Cloudflare Checking your browser"))
        self.assertFalse(is_bot_or_js_barrier("This paper discusses electrolyte conductivity in all-solid batteries."))

        # Task schema validator
        self.assertTrue(validate_task_schema({"task_id": "1", "action": "search", "query": "battery"})[0])
        self.assertFalse(validate_task_schema({"task_id": "2", "action": "hack", "query": "battery"})[0])

    def test_synthesis_intelligence_context(self):
        engine = LocalSynthesizer()
        evidence = [
            {
                "title": "Solid Electrolytes Review",
                "url": "https://example.org/solid",
                "excerpt": "Sulfide-based solid electrolytes demonstrate high room-temperature ionic conductivity reaching 12 mS/cm.",
            }
        ]
        summary = engine.synthesize("solid electrolytes ionic conductivity", evidence)
        self.assertIn("Key Research Findings", summary)
        self.assertIn("https://example.org/solid", summary)

    def test_cost_tracker_and_spend_limits(self):
        tracker = CostTracker(model="gpt-4o-mini", max_spend_usd=0.05)
        # 10,000 prompt tokens + 5,000 completion tokens
        # gpt-4o-mini: 10k * $0.15/M = $0.0015; 5k * $0.60/M = $0.003; total = $0.0045
        spent = tracker.record_usage(prompt_tokens=10000, completion_tokens=5000)
        self.assertAlmostEqual(spent, 0.0045, places=5)
        report = tracker.get_report()
        self.assertEqual(report.total_tokens, 15000)
        self.assertAlmostEqual(report.estimated_cost_usd, 0.0045, places=5)

        # Pre-check cost estimation
        est = tracker.estimate_cost(prompt_tokens=1000, completion_tokens=500)
        self.assertGreater(est, 0.0)

        # Exceeding spend limit should raise SpendLimitExceededError
        with self.assertRaises(SpendLimitExceededError):
            tracker.record_usage(prompt_tokens=500_000_000, completion_tokens=100_000_000)

    def test_cancellation_manager(self):
        token = cancellation_manager.create_token("test_run_xyz")
        self.assertFalse(token.is_set())
        self.assertFalse(cancellation_manager.is_cancelled("test_run_xyz"))

        cancelled = cancellation_manager.cancel_run("test_run_xyz")
        self.assertTrue(cancelled)
        self.assertTrue(token.is_set())
        self.assertTrue(cancellation_manager.is_cancelled("test_run_xyz"))

        cancellation_manager.cancel_all()
        token2 = cancellation_manager.create_token("test_run_2")
        cancellation_manager.cancel_all()
        self.assertTrue(token2.is_set())

    def test_frontier_territory_reservation(self):
        frontier = ResearchFrontier(max_depth=3, max_documents=10)
        frontier.add_candidate("https://example.org/concurrent_worker_1", priority=90.0)
        frontier.add_candidate("https://example.org/concurrent_worker_2", priority=80.0)

        # Worker 1 pops candidate 1
        batch1 = frontier.pop_next_batch(batch_size=1)
        self.assertEqual(len(batch1), 1)
        self.assertEqual(batch1[0].url, "https://example.org/concurrent_worker_1")
        # Candidate 1 is now locked as in_flight
        self.assertIn("https://example.org/concurrent_worker_1", frontier.in_flight_urls)

        # Worker 2 pops candidate 2 (cannot pop candidate 1 again)
        batch2 = frontier.pop_next_batch(batch_size=1)
        self.assertEqual(len(batch2), 1)
        self.assertEqual(batch2[0].url, "https://example.org/concurrent_worker_2")
        self.assertIn("https://example.org/concurrent_worker_2", frontier.in_flight_urls)

        # No more items in queue because both are in-flight
        empty_batch = frontier.pop_next_batch(batch_size=1)
        self.assertEqual(len(empty_batch), 0)

        # Worker 1 finishes fetching and records document
        frontier.record_document("https://example.org/concurrent_worker_1", 2000, "Content Body 1")
        # in_flight is released and URL is recorded
        self.assertNotIn("https://example.org/concurrent_worker_1", frontier.in_flight_urls)
        self.assertIn("https://example.org/concurrent_worker_1", frontier.visited_urls)

        # Worker 2 encounters an error and releases candidate.
        # The URL stays visited (never retried) but leaves in-flight.
        frontier.release_candidate("https://example.org/concurrent_worker_2")
        self.assertNotIn("https://example.org/concurrent_worker_2", frontier.in_flight_urls)
        self.assertIn("https://example.org/concurrent_worker_2", frontier.visited_urls)

    def test_failed_fetch_refunds_domain_budget(self):
        frontier = ResearchFrontier(max_depth=1, max_documents=10, max_per_domain=1)
        frontier.add_candidate("https://example.org/a", priority=90.0)
        frontier.add_candidate("https://example.org/b", priority=80.0)
        batch = frontier.pop_next_batch(batch_size=1)
        self.assertEqual(batch[0].url, "https://example.org/a")
        # Domain budget is full, but sibling URL must stay queued.
        empty = frontier.pop_next_batch(batch_size=1)
        self.assertEqual(empty, [])
        self.assertTrue(any(item.url == "https://example.org/b" for item in frontier.queue))
        frontier.release_candidate(batch[0].url)
        batch2 = frontier.pop_next_batch(batch_size=1)
        self.assertEqual(len(batch2), 1)
        self.assertEqual(batch2[0].url, "https://example.org/b")

    def test_report_archive_and_backward_compatibility(self):
        archive_path = write_report(
            topic="High Entropy Perovskite Oxides",
            evidence=[{"title": "Oxide Review", "url": "https://example.org/oxide", "score": 90}],
            summary="Extracted synthesis on high entropy oxides.",
            watchlist=[],
            metadata={"model": "gpt-4o-mini", "cost_str": "$0.0025", "duration_str": "8.4s"}
        )
        # Dual-write guarantee: both report.md and archived report exist
        self.assertTrue(os.path.exists("report.md"))
        self.assertTrue(os.path.exists(archive_path))
        self.assertIn("reports", archive_path)
        self.assertTrue(archive_path.endswith(".md"))

        with open(archive_path, "r", encoding="utf-8") as f:
            content = f.read()

        # Check metadata header block and content
        self.assertIn("High Entropy Perovskite Oxides", content)
        self.assertIn("Estimated Cost", content)
        self.assertIn("$0.0025", content)
        self.assertIn("Oxide Review", content)

    def test_frontend_assets_exist_and_valid(self):
        base = os.path.dirname(os.path.abspath(__file__))
        html_file = os.path.join(base, "frontend", "public", "index.html")
        theme_css = os.path.join(base, "frontend", "css", "theme.css")
        app_js = os.path.join(base, "frontend", "js", "app.js")

        self.assertTrue(os.path.exists(html_file), "frontend/public/index.html must exist")
        self.assertTrue(os.path.exists(theme_css), "frontend/css/theme.css must exist")
        self.assertTrue(os.path.exists(app_js), "frontend/js/app.js must exist")

        with open(html_file, "r", encoding="utf-8") as f:
            html_content = f.read()
        self.assertIn("/css/theme.css", html_content)
        self.assertIn("/js/app.js", html_content)
        self.assertIn("What are you researching", html_content)
        self.assertIn("Start search", html_content)
        self.assertIn('id="blind-watchlist"', html_content)
        self.assertIn('id="decoy-queries"', html_content)
        self.assertIn('id="ai-planning"', html_content)
        self.assertIn('id="ai-summary"', html_content)
        self.assertIn('id="conceal-process"', html_content)
        self.assertIn('id="confirm-weaker-recall"', html_content)
        # Deep-research controls: depth presets, research/community mix,
        # plan review, and privacy as an optional, collapsed layer.
        self.assertIn('id="presets"', html_content)
        self.assertIn('id="academic-weight"', html_content)
        self.assertIn('id="plan-first"', html_content)
        self.assertIn('id="privacy-panel"', html_content)
        self.assertIn('id="sounding"', html_content)
        self.assertNotIn("selectMode('extreme')", html_content)
        self.assertNotIn("selectMode('deterministic')", html_content)


class TestSearchPreview(unittest.TestCase):
    """Tradeoff preview for one search with explicit options."""

    def test_defaults_do_not_require_confirm(self):
        from backend.research.types import SearchOptions
        from backend.research.preview import preview

        p = preview("solid-state batteries", SearchOptions())
        self.assertFalse(p.requires_confirm)
        self.assertEqual(p.expected_hops, 2)
        self.assertEqual(p.expected_sources, 15)
        self.assertEqual(p.expected_duration_sec, 180.0)
        self.assertEqual(p.expected_spend_usd, 0.0)
        self.assertIn("Free", p.expected_cost_display)

    def test_deep_defaults_declare_minutes_and_gap_rounds(self):
        from backend.research.types import SearchOptions
        from backend.research.preview import preview

        p = preview(
            "solid-state batteries",
            SearchOptions(max_depth=4, max_documents=40, max_duration_min=15.0),
        )
        self.assertEqual(p.expected_hops, 4)
        self.assertEqual(p.expected_sources, 40)
        self.assertEqual(p.expected_duration_sec, 900.0)
        self.assertTrue(any("re-checks" in w.lower() for w in p.warnings))

    def test_long_run_declares_beyond_provider_cap(self):
        from backend.research.types import SearchOptions
        from backend.research.preview import preview

        p = preview("topic", SearchOptions(max_duration_min=60.0))
        self.assertTrue(any("30 min" in w or "provider cap" in w.lower() for w in p.warnings))
        short = preview("topic", SearchOptions(max_duration_min=10.0))
        self.assertFalse(any("provider cap" in w.lower() for w in short.warnings))

    def test_concealer_deep_models_change_spend_estimate(self):
        from backend.research.types import SearchOptions
        from backend.research.preview import preview

        cheap = preview(
            "topic",
            SearchOptions(ai_planning=True, ai_summary=True, deep_model="gpt-4o-mini"),
        )
        deep = preview(
            "topic",
            SearchOptions(ai_planning=True, ai_summary=True, deep_model="gpt-4o"),
        )
        self.assertGreater(deep.expected_spend_usd, cheap.expected_spend_usd)

    def test_blind_requires_confirm_and_warns_weaker_recall(self):
        from backend.research.types import SearchOptions
        from backend.research.preview import preview

        p = preview("topic", SearchOptions(blind_watchlist=True))
        self.assertTrue(p.requires_confirm)
        self.assertTrue(any("weaker recall" in w.lower() for w in p.warnings))

    def test_decoys_require_confirm_and_warn_wasted_query_time(self):
        from backend.research.types import SearchOptions
        from backend.research.preview import preview

        p = preview("topic", SearchOptions(decoy_queries=3))
        self.assertTrue(p.requires_confirm)
        self.assertTrue(any("decoy" in w.lower() for w in p.warnings))

    def test_planning_and_summary_do_not_require_confirm(self):
        from backend.research.types import SearchOptions
        from backend.research.preview import preview

        p = preview("topic", SearchOptions(ai_planning=True, ai_summary=True))
        self.assertFalse(p.requires_confirm)
        self.assertGreater(p.expected_spend_usd, 0.0)
        self.assertTrue(
            any("planning" in w.lower() or "leaves the machine" in w.lower() for w in p.warnings)
        )

    def test_planning_warning_states_concealment_or_bare(self):
        from backend.research.types import SearchOptions
        from backend.research.preview import preview

        concealed = preview("topic", SearchOptions(ai_planning=True, llm_process="hide"))
        self.assertTrue(any("chaffed" in w.lower() for w in concealed.warnings))
        bare = preview("topic", SearchOptions(ai_planning=True, conceal_process=False))
        self.assertFalse(any("chaffed" in w.lower() for w in bare.warnings))

    def test_requires_confirm_iff_blind_or_decoys(self):
        from backend.research.types import SearchOptions
        from backend.research.preview import preview

        self.assertFalse(preview("t", SearchOptions()).requires_confirm)
        self.assertTrue(preview("t", SearchOptions(blind_watchlist=True)).requires_confirm)
        self.assertTrue(preview("t", SearchOptions(decoy_queries=1)).requires_confirm)
        self.assertTrue(
            preview("t", SearchOptions(blind_watchlist=True, decoy_queries=2)).requires_confirm
        )


class TestPlanner(unittest.TestCase):
    """Planner emits tagged real and decoy Query objects."""

    def test_defaults_return_single_real_query(self):
        from backend.research.planner import plan_queries
        from backend.research.types import SearchOptions

        qs = plan_queries("solid-state batteries", [], SearchOptions())
        self.assertEqual(len(qs), 1)
        self.assertEqual(qs[0].text, "solid-state batteries")
        self.assertFalse(qs[0].is_decoy)

    def test_decoys_are_tagged_and_do_not_replace_real(self):
        from backend.research.planner import plan_queries
        from backend.research.types import SearchOptions

        qs = plan_queries("solid-state batteries", [], SearchOptions(decoy_queries=3))
        real = [q for q in qs if not q.is_decoy]
        decoy = [q for q in qs if q.is_decoy]
        self.assertEqual(len(real), 1)
        self.assertEqual(real[0].text, "solid-state batteries")
        self.assertEqual(len(decoy), 3)
        self.assertTrue(all(d.text != "solid-state batteries" for d in decoy))

    @patch.dict(os.environ, {"OPENAI_API_KEY": ""}, clear=False)
    def test_ai_planning_without_key_falls_back_to_topic(self):
        from backend.research.planner import plan_queries
        from backend.research.types import SearchOptions

        qs = plan_queries("topic", [], SearchOptions(ai_planning=True))
        self.assertEqual([q.text for q in qs if not q.is_decoy], ["topic"])

    def test_planning_api_failure_warns_and_keeps_topic(self):
        from backend.research.cloud_errors import CloudCallError
        from backend.research.planner import plan_queries
        from backend.research.types import SearchOptions

        notes = []
        with patch(
            "backend.research.planner.expand_topic_queries",
            side_effect=CloudCallError("planning", RuntimeError("boom")),
        ):
            qs = plan_queries(
                "solid electrolytes",
                [],
                SearchOptions(ai_planning=True),
                progress_callback=notes.append,
            )
        self.assertEqual([q.text for q in qs if not q.is_decoy], ["solid electrolytes"])
        self.assertTrue(any("planning failed" in n.lower() for n in notes))


class TestCloudFallback(unittest.TestCase):
    """OpenAI failures must be visible, then fall back locally."""

    def test_summary_api_failure_warns_and_uses_local(self):
        from backend.research.cloud_errors import CloudCallError
        from backend.research.research_pipeline import _synthesize
        from backend.research.types import SearchOptions

        notes = []
        options = SearchOptions(ai_summary=True)
        evidence = [{
            "title": "Paper",
            "url": "https://example.org/p",
            "excerpt": "Sulfide electrolytes reach 12 mS/cm at room temperature. " * 4,
        }]
        with patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}, clear=False):
            with patch(
                "backend.research.research_pipeline.summarize_with_openai",
                side_effect=CloudCallError("summary", RuntimeError("timeout")),
            ):
                summary, _independence = _synthesize(
                    "solid electrolytes",
                    evidence,
                    [],
                    options,
                    cost_tracker=None,
                    cancel_token=None,
                    progress_callback=notes.append,
                )
        self.assertIn("Key Research Findings", summary)
        self.assertTrue(any("summary failed" in n.lower() for n in notes))
        self.assertTrue(any("local summary" in n.lower() for n in notes))


class TestGuard(unittest.TestCase):
    """Guard asserts or blinds the topic before any network work."""

    def test_assert_blocks_watchlist(self):
        from backend.research.guard import prepare_topic
        from backend.research.types import SearchOptions
        from backend.privacy import SafetyError

        with self.assertRaises(SafetyError):
            prepare_topic("leak SECRET", ["SECRET"], SearchOptions())

    def test_blind_replaces_watchlist(self):
        from backend.research.guard import prepare_topic
        from backend.research.types import SearchOptions

        out = prepare_topic("leak SECRET", ["SECRET"], SearchOptions(blind_watchlist=True))
        self.assertNotIn("SECRET", out)
        self.assertIn("TARGET_ENTITY", out)


class TestExplorer(unittest.TestCase):
    """Explorer discards decoy hits and returns Evidence."""

    def test_decoy_hits_never_become_evidence(self):
        from backend.research.explorer import explore
        from backend.research.types import Evidence, Query, SearchOptions

        collector = MagicMock()

        def send(task, watchlist):
            if task.get("action") == "search":
                q = task["query"]
                slug = q.replace(" ", "-")
                return {
                    "status": "ok",
                    "results": [{
                        "title": q,
                        "url": f"https://example.org/{slug}",
                        "doi": "",
                    }],
                }
            return {
                "status": "ok",
                "content": "Real scientific abstract about electrolytes. " * 20,
                "links": [],
                "bytes": 400,
            }

        collector.send_task.side_effect = send
        qs = [
            Query(text="solid electrolytes", is_decoy=False),
            Query(text="ocean vents", is_decoy=True),
        ]
        ev = explore(
            qs,
            [],
            SearchOptions(max_documents=5, max_depth=0, max_duration_sec=30),
            cancel_token=None,
            collector=collector,
        )
        urls = [e.url for e in ev]
        self.assertTrue(all(isinstance(e, Evidence) for e in ev))
        self.assertFalse(any("ocean" in u for u in urls))
        self.assertTrue(any("solid" in u or "electrolytes" in u for u in urls))


class TestNonePayloadHardening(unittest.TestCase):
    """Real connector payloads carry None titles/snippets/DOIs; nothing may crash."""

    def test_none_fields_survive_frontier_rank_report(self):
        from backend.frontier.priority_frontier import ResearchFrontier
        from backend.ranking.hybrid_ranker import rank_items
        from backend.synthesis.report_generator import write_report
        from backend.research.explorer import _bm25_priorities, _snippet_from_content

        hits = [
            {"title": None, "url": "https://example.com/a", "snippet": None, "doi": None},
            {"title": None, "url": None, "snippet": None},
            "not-a-dict",
        ]
        frontier = ResearchFrontier(max_depth=0, max_documents=5)
        from backend.frontier.url_canonicalizer import canonicalize_url
        for h in hits:
            if isinstance(h, dict):
                raw = h.get("url", "")
                url = canonicalize_url(raw if isinstance(raw, str) else "")
                if url:
                    frontier.add_candidate(url=url, doi=h.get("doi") if isinstance(h.get("doi"), str) else "")
        self.assertEqual(len(frontier.queue), 1)

        self.assertEqual(_bm25_priorities("topic", hits), [45.0, 45.0, 45.0])
        self.assertEqual(_snippet_from_content(None), "")
        self.assertEqual(_snippet_from_content(""), "")

        ranked = rank_items("topic", [
            {"title": None, "url": "https://example.com/a", "snippet": None,
             "excerpt": "text about topic here", "doi": None},
        ])
        self.assertEqual(len(ranked), 1)
        self.assertIsInstance(ranked[0]["score"], float)

        archive = write_report(
            topic="None payload probe",
            evidence=[{"title": None, "url": None, "snippet": None, "excerpt": None}],
            summary="summary",
            watchlist=[],
        )
        self.assertTrue(os.path.exists(archive))

    def test_dense_embedder_coerces_none(self):
        from backend.ranking.dense_embedder import compute_dense_scores
        scores = compute_dense_scores("topic", [None, "real text about topic"])
        self.assertEqual(len(scores), 2)
        self.assertTrue(all(isinstance(s, float) for s in scores))

    def test_explore_with_none_hits_collects_evidence(self):
        from backend.research.explorer import explore
        from backend.research.types import Query, SearchOptions

        collector = MagicMock()
        collector.send_task.side_effect = [
            {"status": "ok", "results": [
                {"title": None, "url": "https://example.com/a", "snippet": None, "doi": None},
            ]},
            {"status": "ok",
             "content": "Findings on renewable storage and grid integration. " * 10,
             "links": [], "bytes": 400},
        ]
        ev = explore(
            [Query(text="grid storage")],
            [],
            SearchOptions(max_depth=0, max_documents=5, concurrency=1,
                           max_gap_rounds=0),
            collector=collector,
        )
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0].url, "https://example.com/a")
        self.assertTrue(ev[0].title)
        self.assertTrue(ev[0].snippet)


class TestRunSearch(unittest.TestCase):
    """run_search composes agents and never ranks decoy hits."""

    def test_run_search_defaults_and_decoy_exclusion(self):
        from backend.research.research_pipeline import run_search
        from backend.research.types import ResearchRun, SearchOptions

        collector = MagicMock()

        def send(task, watchlist):
            if task.get("action") == "search":
                q = task["query"]
                slug = q.replace(" ", "-")
                return {
                    "status": "ok",
                    "results": [{
                        "title": q,
                        "url": f"https://example.org/{slug}",
                        "doi": "",
                    }],
                }
            return {
                "status": "ok",
                "content": "Sulfide solid electrolytes show high ionic conductivity at room temperature. " * 8,
                "links": [],
                "bytes": 400,
            }

        collector.send_task.side_effect = send
        options = SearchOptions(
            max_depth=0,
            max_documents=5,
            max_duration_sec=30,
            decoy_queries=2,
        )
        run = run_search(
            "solid electrolytes",
            [],
            options,
            collector=collector,
        )
        self.assertIsInstance(run, ResearchRun)
        self.assertEqual(run.status, "success")
        urls = [e.url for e in run.evidence]
        self.assertTrue(urls)
        self.assertFalse(any("ocean" in u for u in urls))
        self.assertTrue(all(not q.is_decoy for q in run.queries) or any(not q.is_decoy for q in run.queries))
        decoy_texts = [q.text for q in run.queries if q.is_decoy]
        for decoy in decoy_texts:
            slug = decoy.replace(" ", "-")
            self.assertFalse(any(slug in u for u in urls))


class TestRenamedContexts(unittest.TestCase):
    """Hard-cut package names match the lean map."""

    def test_new_context_packages_import(self):
        import backend.privacy
        import backend.research
        import backend.retrieval
        import backend.frontier
        import backend.ranking
        import backend.synthesis
        from backend.synthesis import LocalSynthesizer

        self.assertTrue(hasattr(backend.privacy, "SafetyError"))
        self.assertTrue(hasattr(backend.research, "run_search"))
        self.assertTrue(callable(LocalSynthesizer))


class TestDeadCodeRemoved(unittest.TestCase):
    def test_build_sanitized_evidence_is_not_exported(self):
        import backend.retrieval as retrieval
        self.assertFalse(hasattr(retrieval, "build_sanitized_evidence"))
        self.assertFalse(hasattr(retrieval, "fetch_html_text"))


class TestThreadedUIServer(unittest.TestCase):
    """Cancel must be able to run while a search is in flight."""

    def test_ui_server_is_threaded(self):
        import socketserver
        from backend.server.web_server import ThreadedUIServer

        self.assertTrue(issubclass(ThreadedUIServer, socketserver.ThreadingMixIn))


class TestDeepSearchCLI(unittest.TestCase):
    """CLI has option flags and no mode enum."""

    def test_cli_has_no_mode_flag(self):
        import deep_search
        parser = argparse.ArgumentParser()
        # Rebuild from module helper if present, else parse -h via main parser factory
        built = deep_search.build_parser()
        help_text = built.format_help()
        self.assertNotIn("--mode", help_text)
        self.assertIn("--blind-watchlist", help_text)
        self.assertIn("--decoys", help_text)
        self.assertIn("--ai-planning", help_text)
        self.assertIn("--no-conceal-process", help_text)
        self.assertIn("--ai-summary", help_text)
        self.assertIn("--preview", help_text)


if __name__ == "__main__":
    unittest.main()
