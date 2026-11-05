"""Unit tests for enhancements: multi-model routing, prompt strictness, and dual report formats."""

import os
import unittest
from unittest.mock import patch, MagicMock

from backend.research.cloud_client import get_api_key, has_api_key, invoke_model
from backend.research.cost_estimator import CostTracker, MODEL_PRICING
from backend.research.types import SearchOptions
from backend.research.query_planner import expand_topic_queries
from backend.research.research_plan import model_plan
from backend.synthesis.report_generator import build_exhaustive_metrics_table, build_structured_report, write_report
from backend.server.web_server import _options_from_payload


class TestEnhancedMultiModel(unittest.TestCase):
    def test_pricing_tiers_include_claude_and_gemini(self):
        self.assertIn("claude-3-5-sonnet", MODEL_PRICING)
        self.assertIn("gemini-1.5-pro", MODEL_PRICING)

    def test_api_key_resolution_per_provider(self):
        with patch.dict(os.environ, {
            "OPENAI_API_KEY": "sk-openai",
            "ANTHROPIC_API_KEY": "sk-ant",
            "GEMINI_API_KEY": "sk-gemini",
        }):
            self.assertEqual(get_api_key("gpt-4o"), "sk-openai")
            self.assertEqual(get_api_key("claude-3-5-sonnet"), "sk-ant")
            self.assertEqual(get_api_key("gemini-1.5-pro"), "sk-gemini")
            self.assertTrue(has_api_key("claude-3-5-sonnet"))
            self.assertTrue(has_api_key("gemini-1.5-pro"))

    def test_invoke_anthropic_routing(self):
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "sk-ant"}):
            with patch("anthropic.Anthropic") as mock_cls:
                client = MagicMock()
                mock_cls.return_value = client
                block = MagicMock()
                block.text = "Anthropic synthesized findings."
                client.messages.create.return_value = MagicMock(content=[block], usage=MagicMock(input_tokens=10, output_tokens=20))

                out = invoke_model("Test prompt", model="claude-3-5-sonnet")
                self.assertEqual(out, "Anthropic synthesized findings.")
                client.messages.create.assert_called_once()


class TestPromptFlexibilityAndStrictness(unittest.TestCase):
    def test_search_options_defaults(self):
        opts = SearchOptions()
        self.assertEqual(opts.strictness, 0.9)
        self.assertTrue(opts.force_direction)
        self.assertEqual(opts.report_format, "comprehensive")

    def test_web_server_options_parsing(self):
        opts = _options_from_payload({
            "strictness": 0.95,
            "force_direction": True,
            "report_format": "structured",
        })
        self.assertEqual(opts.strictness, 0.95)
        self.assertTrue(opts.force_direction)
        self.assertEqual(opts.report_format, "structured")

    def test_expand_topic_queries_honors_force_direction(self):
        with patch("backend.research.cloud_client.get_api_key", return_value="sk-test"):
            with patch("backend.research.cloud_client.invoke_model", return_value="query1\nquery2") as mock_invoke:
                expand_topic_queries("Solid state batteries", [], conceal_process=False, force_direction=True)
                called_prompt = mock_invoke.call_args[0][0]
                self.assertIn("strict adherence", called_prompt.lower())


class TestDualReportFormats(unittest.TestCase):
    def setUp(self):
        self.evidence = [
            {
                "title": "Quantum Hardware Breakthrough",
                "url": "https://example.com/quantum",
                "lane": "academic",
                "score": 88.5,
                "quality": 0.95,
                "snippet": "Researchers achieved 99.9% gate fidelity.",
                "excerpt": "Detailed paper text...",
            },
            {
                "title": "Early Prototype",
                "url": "",  # Missing direct URL
                "lane": "community",
                "score": 45.0,
                "quality": 0.40,
                "snippet": "",  # Missing excerpt/snippet
                "excerpt": "",
            }
        ]

    def test_exhaustive_metrics_table_flags_subpar_and_direct_sources(self):
        table = build_exhaustive_metrics_table(self.evidence, [])
        self.assertIn("Exhaustive Inventory & Objective Metrics Table", table)
        self.assertIn("https://example.com/quantum", table)
        self.assertIn("Complete data", table)
        self.assertIn("Missing direct URL", table)
        self.assertIn("Sub-par / Missing detailed excerpt", table)

    def test_structured_report_generation(self):
        report = build_structured_report("Quantum Computing", self.evidence, "Executive summary here", [])
        self.assertIn("# Structured Brief: Quantum Computing", report)
        self.assertIn("## 1. Executive Summary", report)
        self.assertIn("## 2. Key Insights & Findings", report)
        self.assertIn("## 3. Objective Metrics & Summary Table", report)
        self.assertIn("## 4. Strategic Recommendations & Actionable Next Steps", report)

    def test_write_report_both_formats(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            out_file = os.path.join(tmpdir, "report.md")
            write_report("Test Topic", self.evidence, "Summary", [], output_path=out_file, report_format="both")
            self.assertTrue(os.path.exists(out_file))
            struct_file = os.path.join(tmpdir, "report_structured.md")
            self.assertTrue(os.path.exists(struct_file))
            with open(struct_file, "r", encoding="utf-8") as f:
                content = f.read()
            self.assertIn("# Structured Brief: Test Topic", content)


if __name__ == "__main__":
    unittest.main()
