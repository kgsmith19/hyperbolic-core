"""Fix verification: confirm fixes resolve diagnosed issues.

PDD: Verification produces valid improvement scores and state changes.
SDD: Different fix outcomes are correctly classified.
TDD: Verification integrates with before/after diagnoses.
"""
import unittest
from datetime import datetime
from netcheck import verification_engine


class MockFixRecommendation:
    """Mock fix for testing without importing fix_engine."""
    def __init__(self, fix_id: str, category: str):
        self.id = fix_id
        self.category = category


class VerificationStructureTest(unittest.TestCase):
    """PDD: Verification result has all required fields."""

    def test_verify_fix_returns_complete_result(self):
        """Verification returns fix_id, success, improvement, culprit status."""
        before = {"primary_culprit": "wifi", "synthesis_confidence": 0.8}
        after = {"primary_culprit": None, "synthesis_confidence": 0.2}
        fix = MockFixRecommendation("wifi_fix", "wifi")

        result = verification_engine.verify_fix_resolves_issue(before, fix, after)

        self.assertIn("fix_id", result)
        self.assertIn("success", result)
        self.assertIn("improvement_rate", result)
        self.assertIn("primary_culprit_resolved", result)
        self.assertIn("confidence_change", result)
        self.assertIn("timestamp", result)
        self.assertIn("recommendations", result)

    def test_improvement_rate_bounded_0_1(self):
        """Improvement rate is a valid probability [0, 1]."""
        before = {"primary_culprit": "wifi", "synthesis_confidence": 0.8}
        after = {"primary_culprit": "wifi", "synthesis_confidence": 0.8}
        fix = MockFixRecommendation("test", "wifi")

        result = verification_engine.verify_fix_resolves_issue(before, fix, after)

        self.assertGreaterEqual(result["improvement_rate"], 0.0)
        self.assertLessEqual(result["improvement_rate"], 1.0)

    def test_timestamp_is_valid_iso(self):
        """Result timestamp is valid ISO format."""
        before = {"primary_culprit": "wifi", "synthesis_confidence": 0.7}
        after = {"primary_culprit": "wifi", "synthesis_confidence": 0.7}
        fix = MockFixRecommendation("test", "wifi")

        result = verification_engine.verify_fix_resolves_issue(before, fix, after)

        ts = datetime.fromisoformat(result["timestamp"])
        self.assertIsNotNone(ts)


class CulpritResolutionTest(unittest.TestCase):
    """SDD: Verification detects when culprit changes."""

    def test_culprit_changed_marks_resolved(self):
        """When primary culprit changes, resolution is true."""
        before = {"primary_culprit": "wifi", "synthesis_confidence": 0.85}
        after = {"primary_culprit": None, "synthesis_confidence": 0.1}
        fix = MockFixRecommendation("wifi_fix", "wifi")

        result = verification_engine.verify_fix_resolves_issue(before, fix, after)

        self.assertTrue(result["primary_culprit_resolved"])

    def test_culprit_unchanged_not_resolved(self):
        """When culprit remains same, resolution is false."""
        before = {"primary_culprit": "wifi", "synthesis_confidence": 0.85}
        after = {"primary_culprit": "wifi", "synthesis_confidence": 0.80}
        fix = MockFixRecommendation("router_fix", "router")

        result = verification_engine.verify_fix_resolves_issue(before, fix, after)

        self.assertFalse(result["primary_culprit_resolved"])

    def test_none_culprit_is_healthy(self):
        """None culprit means network is healthy."""
        before = {"primary_culprit": "wifi", "synthesis_confidence": 0.8}
        after = {"primary_culprit": None, "synthesis_confidence": 0.05}
        fix = MockFixRecommendation("wifi_fix", "wifi")

        result = verification_engine.verify_fix_resolves_issue(before, fix, after)

        self.assertTrue(result["primary_culprit_resolved"])


class ConfidenceChangeTest(unittest.TestCase):
    """PDD: Confidence changes are accurately tracked."""

    def test_confidence_decreases_with_fix(self):
        """Applying fix should decrease confidence in the diagnosis."""
        before = {"primary_culprit": "wifi", "synthesis_confidence": 0.9}
        after = {"primary_culprit": "wifi", "synthesis_confidence": 0.3}
        fix = MockFixRecommendation("test", "wifi")

        result = verification_engine.verify_fix_resolves_issue(before, fix, after)

        self.assertLess(result["confidence_change"], 0.0)
        self.assertAlmostEqual(result["confidence_change"], -0.6, places=5)

    def test_confidence_increases_is_negative(self):
        """Increasing confidence in culprit diagnosis is bad."""
        before = {"primary_culprit": "wifi", "synthesis_confidence": 0.5}
        after = {"primary_culprit": "wifi", "synthesis_confidence": 0.9}
        fix = MockFixRecommendation("test", "wifi")

        result = verification_engine.verify_fix_resolves_issue(before, fix, after)

        self.assertGreater(result["confidence_change"], 0.0)


class SuccessDeterminationTest(unittest.TestCase):
    """SDD: Success is determined by improvement and culprit change."""

    def test_success_when_culprit_resolved(self):
        """Fix succeeds if it resolves the culprit."""
        before = {"primary_culprit": "wifi", "synthesis_confidence": 0.85}
        after = {"primary_culprit": None, "synthesis_confidence": 0.1}
        fix = MockFixRecommendation("wifi_fix", "wifi")

        result = verification_engine.verify_fix_resolves_issue(before, fix, after)

        self.assertTrue(result["success"])

    def test_success_with_high_improvement(self):
        """Fix succeeds if improvement rate is high."""
        before = {"primary_culprit": "wifi", "synthesis_confidence": 0.8}
        after = {"primary_culprit": "wifi", "synthesis_confidence": 0.0}
        fix = MockFixRecommendation("test", "wifi")

        result = verification_engine.verify_fix_resolves_issue(before, fix, after)

        self.assertGreaterEqual(result["improvement_rate"], 0.3)

    def test_failure_when_culprit_unchanged(self):
        """Fix fails if culprit doesn't change and confidence stays high."""
        before = {"primary_culprit": "wifi", "synthesis_confidence": 0.85}
        after = {"primary_culprit": "wifi", "synthesis_confidence": 0.80}
        fix = MockFixRecommendation("wrong_fix", "router")

        result = verification_engine.verify_fix_resolves_issue(before, fix, after)

        self.assertFalse(result["success"])


class TrackFixSuccessTest(unittest.TestCase):
    """TDD: Fix tracking records outcome and suggests next action."""

    def test_track_fix_has_required_fields(self):
        """Tracking result includes all status fields."""
        before = {"primary_culprit": "wifi", "synthesis_confidence": 0.8}
        after = {"primary_culprit": None, "synthesis_confidence": 0.1}

        result = verification_engine.track_fix_success("wifi_fix", before, after)

        self.assertIn("fix_id", result)
        self.assertIn("applied_at", result)
        self.assertIn("before_culprit", result)
        self.assertIn("after_culprit", result)
        self.assertIn("culprit_changed", result)
        self.assertIn("next_action", result)
        self.assertIn("success", result)

    def test_track_culprit_change(self):
        """Tracking detects culprit transitions."""
        before = {"primary_culprit": "wifi", "synthesis_confidence": 0.8}
        after = {"primary_culprit": "router", "synthesis_confidence": 0.75}

        result = verification_engine.track_fix_success("test_fix", before, after)

        self.assertEqual(result["before_culprit"], "wifi")
        self.assertEqual(result["after_culprit"], "router")
        self.assertTrue(result["culprit_changed"])

    def test_track_suggests_ethernet_test_for_uncertainty(self):
        """When confidence drops low, Ethernet test is suggested."""
        before = {"primary_culprit": "wifi", "synthesis_confidence": 0.8}
        after = {"primary_culprit": "wifi", "synthesis_confidence": 0.2}

        result = verification_engine.track_fix_success("test_fix", before, after)

        self.assertIn("Ethernet", result["next_action"])

    def test_track_culprit_resolved_success(self):
        """When culprit is resolved, fix is success."""
        before = {"primary_culprit": "wifi", "synthesis_confidence": 0.8}
        after = {"primary_culprit": None, "synthesis_confidence": 0.05}

        result = verification_engine.track_fix_success("wifi_fix", before, after)

        self.assertTrue(result["success"])
        self.assertEqual(result["before_culprit"], "wifi")
        self.assertIsNone(result["after_culprit"])


class LayerComparisonTest(unittest.TestCase):
    """SDD: Comparing layer states identifies improvements."""

    def test_layer_comparison_counts_improvements(self):
        """Comparison detects which layers improved."""
        before = {
            "primary_culprit": "wifi",
            "layer_states": {"wifi": "fail", "router": "pass", "modem": "pass"}
        }
        after = {
            "primary_culprit": None,
            "layer_states": {"wifi": "pass", "router": "pass", "modem": "pass"}
        }

        result = verification_engine.compare_diagnostic_layers(before, after)

        self.assertIn("wifi", result["layers_improved"])
        self.assertEqual(result["net_improvement"], 1)

    def test_layer_comparison_detects_regression(self):
        """Comparison detects when layers regress."""
        before = {
            "primary_culprit": "wifi",
            "layer_states": {"wifi": "pass", "router": "pass"}
        }
        after = {
            "primary_culprit": "wifi",
            "layer_states": {"wifi": "fail", "router": "pass"}
        }

        result = verification_engine.compare_diagnostic_layers(before, after)

        self.assertIn("wifi", result["layers_regressed"])
        self.assertEqual(result["net_improvement"], -1)

    def test_layer_comparison_summary_generated(self):
        """Comparison generates human-readable summary."""
        before = {"layer_states": {"wifi": "fail", "router": "pass"}}
        after = {"layer_states": {"wifi": "pass", "router": "pass"}}

        result = verification_engine.compare_diagnostic_layers(before, after)

        self.assertIn("improved", result["improvement_summary"])
        self.assertIn("regressed", result["improvement_summary"])
        self.assertIn("unchanged", result["improvement_summary"])


class MTTREstimationTest(unittest.TestCase):
    """TDD: MTTR estimation categorizes recovery speed."""

    def test_mttr_immediate_for_high_confidence_fixed(self):
        """High confidence + fix = immediate recovery."""
        before = {"synthesis_confidence": 0.85}
        after = {"synthesis_confidence": 0.1}

        result = verification_engine.estimate_mttr(before, after)

        self.assertEqual(result["category"], "immediate")
        self.assertLess(result["estimated_time_seconds"], 100)

    def test_mttr_slow_for_persistent_high_confidence(self):
        """High confidence + still high = slow/escalation."""
        before = {"synthesis_confidence": 0.85}
        after = {"synthesis_confidence": 0.80}

        result = verification_engine.estimate_mttr(before, after)

        self.assertEqual(result["category"], "slow")
        self.assertGreater(result["estimated_time_seconds"], 300)

    def test_mttr_quick_for_resolved_uncertainty(self):
        """Low confidence resolved quickly."""
        before = {"synthesis_confidence": 0.6}
        after = {"synthesis_confidence": 0.2}

        result = verification_engine.estimate_mttr(before, after)

        self.assertEqual(result["category"], "quick")

    def test_mttr_has_descriptive_notes(self):
        """MTTR result includes explanation."""
        before = {"synthesis_confidence": 0.8}
        after = {"synthesis_confidence": 0.2}

        result = verification_engine.estimate_mttr(before, after)

        self.assertIn("notes", result)
        self.assertTrue(len(result["notes"]) > 0)


class VerificationIntegrationTest(unittest.TestCase):
    """TDD: Verification workflow from diagnosis to outcome."""

    def test_wifi_fix_verification_workflow(self):
        """Complete workflow: diagnose WiFi → apply fix → verify improvement."""
        before_diagnosis = {
            "primary_culprit": "wifi",
            "synthesis_confidence": 0.85,
            "layer_states": {"wifi": "fail", "router": "pass", "modem": "pass"}
        }
        after_diagnosis = {
            "primary_culprit": None,
            "synthesis_confidence": 0.05,
            "layer_states": {"wifi": "pass", "router": "pass", "modem": "pass"}
        }
        fix = MockFixRecommendation("wifi_channel_5ghz", "wifi")

        # Verify fix
        verification = verification_engine.verify_fix_resolves_issue(before_diagnosis, fix, after_diagnosis)
        self.assertTrue(verification["success"])
        self.assertTrue(verification["primary_culprit_resolved"])

        # Track success
        tracking = verification_engine.track_fix_success(fix.id, before_diagnosis, after_diagnosis)
        self.assertTrue(tracking["success"])
        self.assertIn("stability", tracking["next_action"])

        # Compare layers
        layers = verification_engine.compare_diagnostic_layers(before_diagnosis, after_diagnosis)
        self.assertIn("wifi", layers["layers_improved"])

    def test_router_fix_verification_workflow(self):
        """Complete workflow: diagnose router → apply fix → verify."""
        before_diagnosis = {
            "primary_culprit": "router",
            "synthesis_confidence": 0.75,
            "layer_states": {"router": "fail"}
        }
        after_diagnosis = {
            "primary_culprit": None,
            "synthesis_confidence": 0.1,
            "layer_states": {"router": "pass"}
        }
        fix = MockFixRecommendation("disable_aiprotection", "router")

        verification = verification_engine.verify_fix_resolves_issue(before_diagnosis, fix, after_diagnosis)
        self.assertTrue(verification["success"])


if __name__ == "__main__":
    unittest.main()
