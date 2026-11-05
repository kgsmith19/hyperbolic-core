"""Tests for the deep-research engine: lanes, plans, reflection, explorer rounds,
lane-weighted retrieval, telemetry, run registry, deep report, and the API.

All tests are network-free: connectors and collectors are faked.
"""

import json
import os
import tempfile
import threading
import unittest
import urllib.request
from unittest.mock import MagicMock, patch

from backend.research.types import Evidence, Query, SearchOptions


class _InTempDir:
    """Run a block with cwd in a temp dir so reports never land in the repo."""

    def __enter__(self):
        self._old = os.getcwd()
        self._tmp = tempfile.TemporaryDirectory()
        os.chdir(self._tmp.name)
        return self._tmp.name

    def __exit__(self, *exc):
        os.chdir(self._old)
        self._tmp.cleanup()


class TestSourceLanes(unittest.TestCase):
    def test_classify_lanes(self):
        from backend.retrieval.source_quality import classify_lane
        self.assertEqual(classify_lane("https://www.reddit.com/r/science/comments/abc/x/"), "community")
        self.assertEqual(classify_lane("https://www.youtube.com/watch?v=abcdefghijk"), "video")
        self.assertEqual(classify_lane("https://arxiv.org/abs/2401.00001"), "academic")
        self.assertEqual(classify_lane("https://doi.org/10.1000/xyz"), "academic")
        self.assertEqual(classify_lane("https://www.cdc.gov/sleep/index.html"), "gov")
        self.assertEqual(classify_lane("https://someone.substack.com/p/post"), "expert")
        self.assertEqual(classify_lane("https://news.ycombinator.com/item?id=1"), "community")
        self.assertEqual(classify_lane("https://www.sec.gov/Archives/x"), "filings")
        self.assertEqual(classify_lane("https://example.com/forum/thread/123"), "community")
        self.assertEqual(classify_lane("https://example.com/page", source="openalex"), "academic")
        self.assertEqual(classify_lane("https://example.com/page"), "web")

    def test_quality_prior_orders_sources(self):
        from backend.retrieval.source_quality import quality_prior
        paper = quality_prior("https://doi.org/10.1/x", "academic", {"citations": 500})
        thread = quality_prior("https://reddit.com/r/x/comments/1/y", "community", {"score": 900, "comments": 300})
        quiet_thread = quality_prior("https://reddit.com/r/x/comments/2/z", "community", {"score": 1})
        pinterest = quality_prior("https://pinterest.com/pin/1", "web")
        self.assertGreater(paper, quiet_thread)
        self.assertGreater(thread, quiet_thread)
        self.assertLess(pinterest, quiet_thread)

    def test_mix_targets_follow_slider(self):
        from backend.retrieval.source_quality import mix_targets, EVIDENCE_LANES, DISCUSSION_LANES
        balanced = mix_targets(0.5)
        self.assertAlmostEqual(sum(balanced.values()), 1.0, places=3)
        research_heavy = mix_targets(0.9)
        evidence = lambda t: sum(v for k, v in t.items() if k in EVIDENCE_LANES)
        discussion = lambda t: sum(v for k, v in t.items() if k in DISCUSSION_LANES)
        self.assertAlmostEqual(evidence(balanced), discussion(balanced), places=3)
        self.assertGreater(evidence(research_heavy), discussion(research_heavy) * 4)
        only = mix_targets(0.5, ["academic", "community"])
        self.assertEqual(set(only), {"academic", "community"})


class TestFrontierHubs(unittest.TestCase):
    def test_doi_and_subreddit_get_their_own_budget(self):
        from backend.frontier.priority_frontier import ResearchFrontier
        f = ResearchFrontier(max_depth=1, max_documents=50, max_per_domain=1)
        self.assertEqual(f.domain_key("https://doi.org/10.1016/j.x.2020"), "doi.org/10.1016")
        self.assertEqual(f.domain_key("https://www.reddit.com/r/Science/comments/1/x"), "reddit.com/r/science")
        # Distinct DOI prefixes are not throttled by one shared doi.org cap.
        self.assertTrue(f.add_candidate("https://doi.org/10.1016/a", priority=10))
        self.assertTrue(f.add_candidate("https://doi.org/10.1038/b", priority=10))
        f.pop_next_batch(2)
        self.assertTrue(f.add_candidate("https://doi.org/10.3390/c", priority=10))

    def test_batches_diversify_across_lanes(self):
        from backend.frontier.priority_frontier import ResearchFrontier
        f = ResearchFrontier(max_depth=1, max_documents=20, max_per_domain=5)
        lanes = {}
        for i in range(6):
            url = f"https://paper{i}.org/x"
            f.add_candidate(url, priority=90 - i)
            lanes[url] = "academic"
        f.add_candidate("https://forum.org/t", priority=10)
        lanes["https://forum.org/t"] = "community"
        batch = f.pop_next_batch(4, group_of=lambda item: lanes[item.url])
        urls = [item.url for item in batch]
        # The low-priority forum thread jumps ahead of academic items 3-6...
        self.assertIn("https://forum.org/t", urls)
        # ...and the leftover slot is refilled so no reader sits idle.
        self.assertEqual(len(batch), 4)
        self.assertEqual(len(f.queue), 3)

    def test_queue_stays_sorted_and_reprioritizes(self):
        from backend.frontier.priority_frontier import ResearchFrontier
        f = ResearchFrontier(max_depth=1, max_documents=10, max_per_domain=5)
        for i, p in enumerate([5, 50, 20, 40]):
            f.add_candidate(f"https://site{i}.org/x", priority=p)
        self.assertEqual([item.priority for item in f.queue], [50, 40, 20, 5])
        f.reprioritize(lambda item: -item.priority)
        self.assertEqual(f.queue[0].priority, -5)


class TestResearchPlan(unittest.TestCase):
    def test_local_plan_breadth_and_topic_first(self):
        from backend.research.research_plan import local_plan
        plan = local_plan("Does creatine improve cognition in healthy adults?", [], breadth=5)
        self.assertEqual(len(plan.sub_questions), 5)
        self.assertEqual(plan.sub_questions[0].queries[0], "Does creatine improve cognition in healthy adults?")
        self.assertIn("community", plan.sub_questions[1].lanes)
        self.assertTrue(all(sq.queries for sq in plan.sub_questions))

    def test_plan_never_contains_watchlist_terms(self):
        from backend.research.research_plan import local_plan, plan_from_user
        plan = local_plan("ProjectZed battery chemistry", ["ProjectZed"], breadth=4)
        self.assertFalse(any("projectzed" in q.lower() for q in plan.all_queries()))
        user = plan_from_user("topic", [
            {"question": "What about ProjectZed?", "queries": ["ProjectZed specs", "battery specs"]},
            {"question": "Skip me", "queries": ["x"], "enabled": False},
        ], ["ProjectZed"])
        self.assertEqual(len(user.sub_questions), 1)
        self.assertFalse(any("projectzed" in q.lower() for q in user.all_queries()))
        self.assertEqual(user.source, "user")

    def test_build_plan_respects_breadth_one(self):
        from backend.research.research_plan import build_research_plan
        plan = build_research_plan("solar panels", [], SearchOptions())
        self.assertEqual(len(plan.sub_questions), 1)
        self.assertEqual(plan.all_queries(), ["solar panels"])


class TestReflection(unittest.TestCase):
    def test_sentence_value_prefers_findings(self):
        from backend.research.reflection import sentence_value
        self.assertGreater(sentence_value("Creatine improved short-term memory by 12% in vegetarians."), 1.2)
        self.assertEqual(sentence_value("METHODS We conducted a systematic review of five databases."), 0.0)
        self.assertEqual(sentence_value("Reddit thread in r/x: title 3 points, 3 comments."), 0.0)
        self.assertEqual(sentence_value("which was then followed by a second analysis."), 0.0)

    def test_lead_queries_snowball_recurring_entities(self):
        from backend.research.reflection import lead_queries
        docs = [Evidence(title=f"d{i}", url=f"https://e.org/{i}", snippet="",
                         excerpt="Results from the Mayo Clinic showed benefits. Abstract PubMed Scopus.")
                for i in range(3)]
        out = lead_queries("creatine cognition", docs, set(), [])
        self.assertTrue(any("Mayo Clinic" in q for q in out))
        self.assertFalse(any(q.endswith(("Abstract", "PubMed", "Scopus")) for q in out))

    def test_best_passages_picks_relevant_chunk(self):
        from backend.research.reflection import best_passages
        filler = "Unrelated paragraph about gardening tools and weather. " * 40
        target = "Creatine supplementation improved cognition scores by 15 percent in older adults. " * 6
        text = f"{filler}\n\n{target}\n\n{filler}"
        out = best_passages(text, "creatine cognition older adults", max_chars=1500)
        self.assertIn("Creatine supplementation improved cognition", out)
        self.assertLessEqual(len(out), 1600)


def _respond_factory(results_by_query=None, fetch=None):
    """Protocol-agnostic fake collector."""
    calls = []

    def respond(task, watchlist):
        calls.append(task)
        if task.get("action") == "search":
            if results_by_query and task["query"] in results_by_query:
                return {"status": "ok", "results": results_by_query[task["query"]]}
            return {"status": "ok", "results": []}
        if task.get("action") == "fetch":
            if fetch:
                return fetch(task["url"])
            return {"status": "ok", "content": "Creatine and cognition evidence. " * 10, "links": [], "bytes": 300}
        return {"status": "ok", "results": []}

    collector = MagicMock()
    collector.send_task.side_effect = respond
    return collector, calls


class TestExplorerDeep(unittest.TestCase):
    def test_lane_budget_sent_with_searches(self):
        from backend.research.explorer import explore
        collector, calls = _respond_factory()
        explore([Query("creatine cognition")], [],
                SearchOptions(max_depth=0, max_documents=5, max_gap_rounds=0, concurrency=1,
                              source_lanes=["academic", "community", "video"], academic_weight=0.5),
                collector=collector)
        searches = [c for c in calls if c.get("action") == "search"]
        self.assertTrue(searches)
        lanes = searches[0]["lanes"]
        self.assertEqual(set(lanes), {"academic", "community", "video"})
        self.assertTrue(all(isinstance(v, int) and v > 0 for v in lanes.values()))

    def test_classic_mode_sends_no_lanes(self):
        from backend.research.explorer import explore
        collector, calls = _respond_factory()
        explore([Query("t")], [], SearchOptions(max_depth=0, max_documents=5, max_gap_rounds=0, concurrency=1),
                collector=collector)
        self.assertNotIn("lanes", [c for c in calls if c.get("action") == "search"][0])

    def test_paywalled_paper_falls_back_to_abstract(self):
        from backend.research.explorer import explore
        abstract = "Creatine supplementation improved memory in older adults across eight trials. " * 5
        collector, _ = _respond_factory(
            {"creatine memory": [{"title": "Paper", "url": "https://doi.org/10.1/p", "abstract": abstract,
                                  "lane": "academic", "meta": {"citations": 40}}]},
            fetch=lambda url: {"status": "error", "error": "HTTP 403"},
        )
        with patch.dict(os.environ, {"DEEPSEARCH_DISABLE_WAYBACK": "1"}):
            ev = explore([Query("creatine memory")], [],
                         SearchOptions(max_depth=0, max_documents=5, max_gap_rounds=0, concurrency=1),
                         collector=collector)
        self.assertEqual(len(ev), 1)
        self.assertIn("|abstract", ev[0].source)
        self.assertEqual(ev[0].lane, "academic")
        self.assertGreater(ev[0].quality, 0.8)
        self.assertEqual(ev[0].meta.get("renderer"), "abstract")

    def test_exclude_urls_are_skipped(self):
        from backend.research.explorer import explore
        collector, calls = _respond_factory({"q": [{"title": "Seen", "url": "https://a.org/seen"},
                                                   {"title": "New", "url": "https://b.org/new"}]})
        ev = explore([Query("q")], [], SearchOptions(max_depth=0, max_documents=5, max_gap_rounds=0, concurrency=1,
                                                     exclude_urls=["https://a.org/seen"]), collector=collector)
        self.assertEqual([e.url for e in ev], ["https://b.org/new"])

    def test_off_topic_link_hops_are_dropped(self):
        from backend.research.explorer import explore

        def fetch(url):
            if "offtopic" in url:
                return {"status": "ok", "content": "Gardening tools and lawn mower reviews for spring. " * 10,
                        "links": [], "bytes": 300}
            return {"status": "ok", "content": "Creatine cognition memory trial results. " * 10,
                    "links": ["https://elsewhere.org/offtopic"], "bytes": 300}

        collector, _ = _respond_factory({"creatine cognition memory": [{"title": "T", "url": "https://a.org/t"}]}, fetch)
        ev = explore([Query("creatine cognition memory")], [],
                     SearchOptions(max_depth=1, max_documents=5, max_gap_rounds=0, concurrency=1),
                     collector=collector)
        self.assertEqual([e.url for e in ev], ["https://a.org/t"])

    def test_reflection_rounds_emit_learnings_and_follow_up_searches(self):
        from backend.research.explorer import explore
        from backend.research.research_plan import local_plan
        from backend.research.telemetry import Telemetry

        counter = {"n": 0}

        def respond(task, watchlist):
            if task.get("action") == "search":
                counter["n"] += 1
                return {"status": "ok", "results": [
                    {"title": f"Study {counter['n']}", "url": f"https://site{counter['n']}.org/a"}]}
            if task.get("action") == "fetch":
                return {"status": "ok", "links": [], "bytes": 300,
                        "content": (f"Source {task['url']}: creatine supplementation improved memory scores by 14% in the "
                                    "Harvard Medical School trial. Researchers at Harvard Medical School found cognition "
                                    "benefits. ") * 4}
            return {"status": "ok", "results": []}

        collector = MagicMock()
        collector.send_task.side_effect = respond
        events, learnings = [], []
        plan = local_plan("creatine cognition", [], breadth=3)
        ev = explore([Query(q) for q in plan.all_queries()], [],
                     SearchOptions(max_depth=0, max_documents=12, max_gap_rounds=2, concurrency=2,
                                   citation_expansion=False, breadth=3),
                     collector=collector, telemetry=Telemetry(event_callback=events.append),
                     plan=plan, learnings_out=learnings)
        types = {e["type"] for e in events}
        self.assertTrue({"stage", "source", "round", "stats"} <= types)
        self.assertTrue(learnings)
        self.assertTrue(all(e.subq for e in ev))
        searched = [c.args[0]["query"] for c in collector.send_task.call_args_list if c.args[0].get("action") == "search"]
        self.assertGreater(len(searched), len(plan.all_queries()))


class TestLaneRouter(unittest.TestCase):
    def test_search_lanes_tags_merges_and_respects_budgets(self):
        from backend.retrieval import retrieval_router as rr
        router = rr.RetrievalRouter()
        seen = {}

        def fake(name, items):
            def fn(*args, **kwargs):
                seen[name] = kwargs or args[1:]
                return items
            return fn

        paper = {"title": "P", "url": "https://doi.org/10.1/p", "source": "crossref", "snippet": "short"}
        rich = {"title": "P", "url": "https://doi.org/10.1/p", "source": "openalex", "abstract": "long abstract " * 30,
                "meta": {"citations": 9}}
        thread = {"title": "T", "url": "https://www.reddit.com/r/x/comments/1/t", "source": "reddit"}
        with patch.multiple(rr,
                            search_openalex=fake("openalex", [rich]),
                            search_semantic_scholar=fake("s2", []),
                            search_europepmc=fake("epmc", []),
                            search_arxiv=fake("arxiv", []),
                            search_crossref=fake("crossref", [paper]),
                            search_pubmed=fake("pubmed", []),
                            search_doaj=fake("doaj", []),
                            search_reddit=fake("reddit", [thread]),
                            search_hackernews=fake("hn", []),
                            search_stackexchange=fake("se", []),
                            search_youtube=fake("yt", []),
                            vertical_search=fake("vertical", [])):
            out = router.search_lanes("creatine", {"academic": 6, "community": 4, "video": 0})
        self.assertEqual(len(out), 2)
        merged = next(o for o in out if o["url"].startswith("https://doi.org"))
        self.assertTrue(merged["abstract"].startswith("long abstract"))
        self.assertEqual(merged["lane"], "academic")
        self.assertEqual(next(o for o in out if "reddit" in o["url"])["lane"], "community")
        self.assertEqual(seen["openalex"], {"per_page": 6})
        self.assertNotIn("yt", seen)

    def test_task_validator_accepts_lanes_and_citations(self):
        from backend.retrieval.task_validator import validate_task_schema
        self.assertTrue(validate_task_schema({"action": "search", "query": "q", "lanes": {"academic": 5}})[0])
        self.assertFalse(validate_task_schema({"action": "search", "query": "q", "lanes": {"academic": "5"}})[0])
        self.assertFalse(validate_task_schema({"action": "search", "query": "q", "lanes": {"academic": 999}})[0])
        self.assertTrue(validate_task_schema({"action": "citations", "url": "https://doi.org/10.1/x",
                                              "connector": "cited_by", "limit": 5})[0])
        self.assertFalse(validate_task_schema({"action": "citations", "url": "x", "connector": "sideways"})[0])


class TestDeepPipeline(unittest.TestCase):
    def test_run_search_with_plan_lanes_events_and_archive(self):
        from backend.research.research_pipeline import run_search, run_to_dict

        def respond(task, watchlist):
            if task.get("action") == "search":
                slug = abs(hash(task["query"])) % 10_000
                return {"status": "ok", "results": [
                    {"title": f"Creatine paper {slug}", "url": f"https://doi.org/10.1{slug % 7}/{slug}", "lane": "academic"},
                    {"title": f"Creatine thread {slug}", "url": f"https://www.reddit.com/r/s{slug % 5}/comments/{slug}/x",
                     "lane": "community", "meta": {"score": 50, "comments": 20}},
                ]}
            return {"status": "ok", "links": [], "bytes": 300,
                    "content": f"Page {task['url']}. " + "Creatine supplementation improved memory and cognition in older adults by 10%. " * 6}

        collector = MagicMock()
        collector.send_task.side_effect = respond
        events = []
        with _InTempDir() as tmp:
            run = run_search(
                "creatine cognition older adults", [],
                SearchOptions(max_depth=0, max_documents=10, max_gap_rounds=1, concurrency=2, breadth=3,
                              source_lanes=["academic", "community"], citation_expansion=False,
                              rerank_keep=10, max_duration_min=1),
                collector=collector, event_callback=events.append, ledger_root=os.path.join(tmp, "runs"))
            payload = run_to_dict(run)
            archive_json = os.path.splitext(run.archive_path)[0] + ".json"
            self.assertTrue(os.path.exists(archive_json))
            with open(archive_json, encoding="utf-8") as handle:
                stored = json.load(handle)
            with open(run.archive_path, encoding="utf-8") as handle:
                report = handle.read()
        self.assertEqual(run.status, "success")
        self.assertEqual(len(payload["plan"]["sub_questions"]), 3)
        self.assertEqual(payload["queries"][0], "creatine cognition older adults")
        self.assertTrue({"academic", "community"} <= set(payload["stats"]["lane_counts"]))
        self.assertIn("## Research vs. Community", run.summary)
        self.assertIn("## Methodology", report)
        self.assertEqual(stored["topic"], "creatine cognition older adults")
        stages = [e["stage"] for e in events if e["type"] == "stage"]
        self.assertEqual(stages[0], "plan")
        self.assertEqual(stages[-1], "done")
        self.assertTrue(any(e["type"] == "plan" for e in events))

    def test_deep_brief_local_structure_and_citation_fix(self):
        from backend.synthesis.deep_report import build_local_brief, _fix_citations
        ev = [
            {"title": "Trial", "url": "https://doi.org/10.1/a", "lane": "academic", "quality": 0.9,
             "excerpt": "Creatine supplementation improved memory by 12% in a randomized trial of older adults."},
            {"title": "Thread", "url": "https://reddit.com/r/x/comments/1/y", "lane": "community", "quality": 0.6,
             "meta": {"community": "r/Nootropics"},
             "excerpt": "Many lifters report creatine improved their focus and reduced brain fog within two weeks."},
            {"title": "Talk", "url": "https://youtube.com/watch?v=abcdefghijk", "lane": "video", "quality": 0.6,
             "meta": {"author": "Lab Channel", "views": 12000, "has_transcript": True},
             "excerpt": "In this talk the researcher explains creatine improved cognition under sleep deprivation."},
        ]
        brief = build_local_brief("creatine memory cognition", ev, followups=["How does sleep relate to creatine?"])
        for heading in ("## Executive Summary", "## Research vs. Community", "## Top Videos", "## Open Questions"):
            self.assertIn(heading, brief)
        self.assertIn("[1]", brief)
        self.assertEqual(_fix_citations("A [1] B [2, 9] C [7]", 3), "A [1] B [2] C ")


class TestProductDefaults(unittest.TestCase):
    """AI report is the default when a key exists; every privacy/hiding option is opt-in."""

    def _assert_privacy_off(self, opts):
        self.assertFalse(opts.blind_watchlist)
        self.assertEqual(opts.decoy_queries, 0)
        self.assertEqual(opts.llm_process, "show")
        self.assertFalse(opts.conceal_process)

    def test_server_defaults(self):
        from backend.server.web_server import _options_from_payload
        with patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}):
            for payload in ({}, {"preset": "deep"}, {"preset": "scout"}):
                opts = _options_from_payload(payload)
                self.assertTrue(opts.ai_summary)
                self._assert_privacy_off(opts)
            self.assertFalse(_options_from_payload({"ai_summary": False}).ai_summary)
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}):
            self.assertFalse(_options_from_payload({}).ai_summary)

    def test_cli_defaults(self):
        import sys
        sys.path.insert(0, ".")
        from deep_search import build_options, build_parser
        with patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}):
            for argv in ([], ["--preset", "marathon"]):
                opts = build_options(build_parser().parse_args(argv))
                self.assertTrue(opts.ai_summary)
                self._assert_privacy_off(opts)
            self.assertFalse(build_options(build_parser().parse_args(["--no-ai-summary"])).ai_summary)
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}):
            self.assertFalse(build_options(build_parser().parse_args([])).ai_summary)
            self.assertTrue(build_options(build_parser().parse_args(["--ai-summary"])).ai_summary)

    def test_ui_defaults(self):
        base = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(base, "frontend", "public", "index.html"), encoding="utf-8") as handle:
            html = handle.read()
        self.assertIn('id="ai-summary" checked', html)
        for privacy_id in ("blind-watchlist", "conceal-process", "confirm-weaker-recall"):
            self.assertNotRegex(html, rf'id="{privacy_id}"[^>]*checked')
        self.assertIn('id="decoy-queries" min="0" max="8" value="0"', html)
        self.assertNotRegex(html, r'<details[^>]*id="privacy-panel"[^>]*open')


class TestRunRegistry(unittest.TestCase):
    def test_buffered_events_and_reattach(self):
        from backend.server.run_registry import RunRegistry
        reg = RunRegistry(keep=3)
        handle = reg.create("topic", {})
        handle.push({"type": "progress", "message": "a"})
        events, done = handle.wait_from(0, timeout=0.01)
        self.assertEqual(len(events), 1)
        self.assertFalse(done)

        def later():
            handle.push({"type": "progress", "message": "b"})
            handle.finish("success")
        threading.Timer(0.05, later).start()
        events, done = handle.wait_from(1, timeout=2)
        self.assertEqual(events[0]["message"], "b")
        self.assertEqual(reg.list()[0]["run_id"], handle.run_id)


class TestApiEndpoints(unittest.TestCase):
    def setUp(self):
        from backend.server import web_server
        self.web_server = web_server
        self.httpd = web_server.ThreadedUIServer(("127.0.0.1", 0), web_server.SafeResearchRequestHandler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def _get(self, path):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}", timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _post(self, path, body):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def test_presets_endpoint(self):
        data = self._get("/api/presets")
        self.assertEqual(set(data["presets"]), {"scout", "standard", "deep", "marathon"})
        self.assertIn("community", data["default_lanes"])

    def test_plan_endpoint_drafts_editable_plan(self):
        with patch("backend.research.guard.enforce_secret_core_socket_block"):
            data = self._post("/api/plan", {"topic": "creatine cognition", "preset": "deep"})
        self.assertEqual(len(data["plan"]["sub_questions"]), 8)
        self.assertEqual(data["plan"]["sub_questions"][0]["queries"][0], "creatine cognition")

    def test_preset_payload_fills_deep_defaults(self):
        opts = self.web_server._options_from_payload({"preset": "marathon"})
        self.assertEqual(opts.max_documents, 1500)
        self.assertGreaterEqual(opts.max_duration_min, 120)
        self.assertEqual(opts.breadth, 12)
        self.assertIn("community", opts.source_lanes)
        self.assertEqual(opts.rerank_keep, 1500)
        explicit = self.web_server._options_from_payload({"preset": "marathon", "max_documents": 50})
        self.assertEqual(explicit.max_documents, 50)


if __name__ == "__main__":
    unittest.main()
