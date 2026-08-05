"""Configuration Matrix: track tested combinations and guide troubleshooting.

Tests verify:
1. All state tracked correctly (test date, outcome, error count)
2. Matrix suggests highest-impact next test
3. Prevents redundant testing
4. Handles fix application and regression
5. Integrates with diagnostic engine
"""
import unittest
from datetime import datetime, timedelta
from unittest.mock import Mock, patch

from netcheck import diagnose


class ConfigurationMatrixStateTest(unittest.TestCase):
    """Criterion 1: Matrix tracks complete test history."""

    def test_record_test_captures_all_metadata(self):
        """When recording a test result, capture everything needed for ranking/trending."""
        matrix = diagnose.ConfigurationMatrix()

        matrix.record_test(
            variable="wifi_mode",
            value="802.11ac",
            outcome="fail",
            error_count=14,
            duration_hours=72,
            date="2026-08-05T10:00:00Z",
            notes="Connected but errors under load"
        )

        record = matrix.get_test_record("wifi_mode", "802.11ac")
        self.assertEqual(record["variable"], "wifi_mode")
        self.assertEqual(record["value"], "802.11ac")
        self.assertEqual(record["outcome"], "fail")
        self.assertEqual(record["error_count"], 14)
        self.assertEqual(record["duration_hours"], 72)
        self.assertEqual(record["notes"], "Connected but errors under load")

    def test_record_test_assigns_impact_score_intelligently(self):
        """Impact score based on: how many errors did this config cause?
        14 errors = high impact. 0 errors after fix = high confirmation."""
        matrix = diagnose.ConfigurationMatrix()

        # First: Wi-Fi mode 802.11ac with 14 errors
        matrix.record_test("wifi_mode", "802.11ac", "fail", error_count=14)
        record1 = matrix.get_test_record("wifi_mode", "802.11ac")
        self.assertGreater(record1["impact_score"], 80,
                          "14 errors = very high impact")

        # Later: Wi-Fi mode 802.11ax with 0 errors (after fix)
        matrix.record_test("wifi_mode", "802.11ax", "success", error_count=0, fix_applied=True)
        record2 = matrix.get_test_record("wifi_mode", "802.11ax")
        self.assertGreater(record2["impact_score"], 90,
                          "Fix applied + no errors = very high confidence")

    def test_multiple_test_runs_of_same_config_tracked_separately(self):
        """Tested Wi-Fi mode 802.11ac on 2026-08-04 (14 errors).
        Tested again on 2026-08-05 (still 14 errors).
        Both recorded in history."""
        matrix = diagnose.ConfigurationMatrix()

        matrix.record_test("wifi_mode", "802.11ac", "fail", error_count=14,
                          date="2026-08-04T10:00:00Z")
        matrix.record_test("wifi_mode", "802.11ac", "fail", error_count=14,
                          date="2026-08-05T10:00:00Z")

        history = matrix.get_history("wifi_mode", "802.11ac")
        self.assertEqual(len(history), 2,
                        "Both test runs should be recorded")
        self.assertEqual(history[0]["date"], "2026-08-04T10:00:00Z")
        self.assertEqual(history[1]["date"], "2026-08-05T10:00:00Z")

    def test_matrix_integrates_with_diagnostic_culprit_tracking(self):
        """When a culprit is diagnosed, record it in matrix.
        Router DNS blamed -> mark as tested, outcome=fail."""
        matrix = diagnose.ConfigurationMatrix()
        diagnosis = {"culprit": "router_dns", "confidence": 0.95}

        matrix.record_diagnosis_outcome("router_dns", outcome="fail", diagnosis=diagnosis)

        record = matrix.get_test_record("router_dns", "enabled")
        self.assertEqual(record["outcome"], "fail")
        self.assertEqual(record["confidence"], 0.95)


class NextTestSuggestionTest(unittest.TestCase):
    """Criterion 2: Suggest highest-impact, untested variable next."""

    def test_suggests_untested_value_of_problematic_variable(self):
        """Tested: wifi_mode=802.11ac (14 errors, impact=95).
        Untested: wifi_mode=802.11ax.
        Suggestion: Test 802.11ax."""
        matrix = diagnose.ConfigurationMatrix()
        matrix.record_test("wifi_mode", "802.11ac", "fail", error_count=14, impact_score=95)
        # 802.11ax untested

        suggestion = matrix.suggest_next_test()
        self.assertEqual(suggestion["variable"], "wifi_mode",
                        "Should suggest testing the high-impact variable")
        self.assertEqual(suggestion["value"], "802.11ax",
                        "Should suggest untested value")
        self.assertGreater(suggestion["expected_impact"], 90,
                          "High impact (directly addresses known issue)")

    def test_does_not_suggest_already_tested_combination(self):
        """Tested: wifi_mode=802.11ac. Tested: wifi_mode=802.11ax.
        Don't suggest either again unless there's a reason."""
        matrix = diagnose.ConfigurationMatrix()
        matrix.record_test("wifi_mode", "802.11ac", "fail")
        matrix.record_test("wifi_mode", "802.11ax", "success")

        suggestion = matrix.suggest_next_test()
        # Should suggest something else, not re-test these
        self.assertNotEqual(suggestion["variable"], "wifi_mode",
                           "Don't suggest re-testing wifi_mode")

    def test_ranks_suggestions_by_expected_roi(self):
        """Multiple untested options. Rank by: impact * feasibility / cost.
        High impact + low cost = #1."""
        matrix = diagnose.ConfigurationMatrix()

        # High impact, low cost (high ROI)
        matrix.track_untested_option("wifi_mode", "802.11ax",
                                     impact=95, cost=1, feasibility=1.0)
        # High impact, high cost (medium ROI)
        matrix.track_untested_option("modem_reboot", "yes",
                                     impact=50, cost=3, feasibility=0.9)
        # Low impact, low cost (low ROI)
        matrix.track_untested_option("tcp_autotuning", "off",
                                     impact=10, cost=1, feasibility=0.8)

        ranked = matrix.suggest_next_tests(limit=3)
        self.assertEqual(ranked[0]["variable"], "wifi_mode",
                        "Highest ROI (95*1.0 / 1) should be first")

    def test_suggestion_includes_expected_effort(self):
        """Suggestion should tell user: 'easy', 'medium', 'hard'."""
        matrix = diagnose.ConfigurationMatrix()
        matrix.track_untested_option("wifi_mode", "802.11ax", impact=95, cost=1)

        suggestion = matrix.suggest_next_test()
        self.assertIn("effort", suggestion,
                     "Should include effort estimate")
        self.assertEqual(suggestion["effort"], "easy",
                        "Running script = easy")

    def test_suggestion_includes_expected_result(self):
        """Suggestion should estimate outcomes:
        'If this fixes errors -> causal. If errors continue -> ruled out.'"""
        matrix = diagnose.ConfigurationMatrix()
        matrix.record_test("wifi_mode", "802.11ac", "fail", error_count=14)

        suggestion = matrix.suggest_next_test()
        self.assertIn("expected_outcome_if_success", suggestion)
        self.assertIn("expected_outcome_if_failure", suggestion)
        self.assertIn("causal", suggestion["expected_outcome_if_success"].lower())
        self.assertIn("ruled out", suggestion["expected_outcome_if_failure"].lower())


class RedundancyPreventionTest(unittest.TestCase):
    """Criterion 3: Don't waste time re-testing what's already known."""

    def test_prevents_retesting_same_condition_within_short_window(self):
        """Tested: router DNS (2 hours ago, worked).
        Don't suggest testing it again immediately."""
        matrix = diagnose.ConfigurationMatrix()
        matrix.record_test("router_dns", "queried", "ok",
                          date=(datetime.utcnow() - timedelta(hours=2)).isoformat())

        suggestion = matrix.suggest_next_test()
        self.assertNotEqual(suggestion["variable"], "router_dns",
                           "Don't retest DNS within 24 hours if no reason")

    def test_allows_retesting_if_network_changed(self):
        """Tested: DNS 2 hours ago.
        But: modem rebooted (uptime reset from 72h to 2h).
        Network changed -> retest is warranted."""
        matrix = diagnose.ConfigurationMatrix()
        matrix.record_test("router_dns", "queried", "ok",
                          date=(datetime.utcnow() - timedelta(hours=2)).isoformat())
        matrix.note_state_change("modem_restart", "uptime changed from 72h to 2h")

        # Now testing DNS again is justified
        suggestion = matrix.suggest_next_test(context="modem_restarted")
        self.assertEqual(suggestion["variable"], "router_dns",
                        "Retesting DNS justified after major network event")

    def test_prevents_expensive_tests_if_already_tested(self):
        """Expensive test: full modem diagnostics.
        Only run if untested or if state changed significantly."""
        matrix = diagnose.ConfigurationMatrix()
        matrix.record_test("modem_full_scan", "yes", "ok",
                          date=(datetime.utcnow() - timedelta(hours=6)).isoformat(),
                          cost="high")

        # Don't suggest expensive test if just done
        suggestion = matrix.suggest_next_test()
        self.assertNotEqual(suggestion.get("variable"), "modem_full_scan",
                           "Don't suggest expensive test recently run")


class FixTrackingTest(unittest.TestCase):
    """Criterion 4: Track fixes applied, measure outcomes, detect regression."""

    def test_record_fix_application(self):
        """Applied fix: Wi-Fi mode to 802.11ax.
        Record: what changed, when, by what method."""
        matrix = diagnose.ConfigurationMatrix()
        matrix.record_fix_applied(
            variable="wifi_mode",
            from_value="802.11ac",
            to_value="802.11ax",
            method="scripts/reset-wifi-adapter.ps1",
            date="2026-08-05T15:30:00Z"
        )

        fix_record = matrix.get_fix_record("wifi_mode")
        self.assertEqual(fix_record["from"], "802.11ac")
        self.assertEqual(fix_record["to"], "802.11ax")
        self.assertEqual(fix_record["method"], "scripts/reset-wifi-adapter.ps1")

    def test_record_outcome_after_fix(self):
        """Fix applied 2026-08-05.
        Monitoring 2026-08-06: errors = 0.
        Record: fix successful."""
        matrix = diagnose.ConfigurationMatrix()
        matrix.record_fix_applied("wifi_mode", "802.11ac", "802.11ax",
                                 date="2026-08-05T15:30:00Z")
        matrix.record_post_fix_outcome(
            variable="wifi_mode",
            errors_after=0,
            duration_hours=24,
            date="2026-08-06T15:30:00Z",
            verdict="success"
        )

        outcome = matrix.get_fix_outcome("wifi_mode")
        self.assertEqual(outcome["verdict"], "success")
        self.assertEqual(outcome["errors_after"], 0)

    def test_detect_fix_regression(self):
        """Fix applied: wifi_mode -> 802.11ax (recorded).
        Later: wifi_mode = 802.11ac (detected via snapshot).
        Alert: regression."""
        matrix = diagnose.ConfigurationMatrix()
        matrix.record_fix_applied("wifi_mode", "802.11ac", "802.11ax",
                                 date="2026-08-05T15:30:00Z")

        # Simulate snapshot detection
        regression = matrix.detect_regression_in_field("wifi_mode", "802.11ac")
        self.assertTrue(regression,
                       "Should detect that fix reverted")

    def test_compare_pre_fix_vs_post_fix_metrics(self):
        """Pre-fix: 14 errors in 72h. Post-fix: 0 errors in 72h.
        Improvement: 100% reduction."""
        matrix = diagnose.ConfigurationMatrix()
        matrix.record_test("wifi_mode", "802.11ac", "fail", error_count=14,
                          duration_hours=72)
        matrix.record_fix_applied("wifi_mode", "802.11ac", "802.11ax")
        matrix.record_post_fix_outcome("wifi_mode", errors_after=0,
                                      duration_hours=72)

        improvement = matrix.calculate_improvement("wifi_mode")
        self.assertEqual(improvement["error_reduction_pct"], 100,
                        "Should show 100% reduction in errors")
        self.assertGreater(improvement["confidence"], 0.95,
                          "High confidence in fix effectiveness")


class HistoricalTrendAnalysisTest(unittest.TestCase):
    """Criterion 5: Analyze trends over time to identify systemic patterns."""

    def test_identify_repeating_culprit_across_bursts(self):
        """Culprit across last 5 error bursts: router_dns (100%).
        Pattern: router DNS is THE problem."""
        matrix = diagnose.ConfigurationMatrix()
        for i in range(5):
            matrix.record_diagnosis_outcome("router_dns", outcome="fail",
                                           burst_num=i+1)

        trend = matrix.analyze_culprit_trend("router_dns")
        self.assertEqual(trend["frequency"], 5,
                        "Router DNS blamed 5 times")
        self.assertEqual(trend["consistency_pct"], 100,
                        "100% of bursts blamed router DNS")

    def test_identify_transient_issue_vs_systematic(self):
        """Burst 1: interference detected. Burst 2-5: no interference.
        Conclusion: Transient, not systematic."""
        matrix = diagnose.ConfigurationMatrix()
        matrix.record_diagnosis_outcome("interference", outcome="ok", burst_num=1)
        for i in range(2, 6):
            matrix.record_diagnosis_outcome("interference", outcome=None, burst_num=i)

        trend = matrix.analyze_culprit_trend("interference")
        self.assertEqual(trend["consistency_pct"], 20,
                        "Interference in only 1 of 5 bursts")
        self.assertEqual(trend["pattern"], "transient",
                        "Should be classified as transient")

    def test_identify_cascading_failures(self):
        """Burst 1: Modem reboots -> DNS fails -> TLS fails.
        Pattern: cascading (modem restart triggered 2 downstream failures)."""
        matrix = diagnose.ConfigurationMatrix()
        burst = {
            "modem_restart": {"cause": True},
            "router_dns": {"failed_after": "modem_restart"},
            "tls_connect": {"failed_after": "router_dns"}
        }
        matrix.record_burst_diagnosis(burst)

        cascade = matrix.detect_cascading_failure()
        self.assertEqual(cascade["root"], "modem_restart",
                        "Modem restart is root cause")
        self.assertIn("router_dns", cascade["downstream"],
                     "DNS failure downstream of modem")


class ConfigurationMatrixIntegrationTest(unittest.TestCase):
    """Criterion 6: Matrix integrates with diagnostic engine."""

    def test_matrix_and_diagnostic_tree_agree_on_culprit(self):
        """Diagnostic tree says: router_dns.
        Matrix history shows: router_dns blamed 4 of 5 times.
        Both agree -> confidence high."""
        matrix = diagnose.ConfigurationMatrix()
        for i in range(4):
            matrix.record_diagnosis_outcome("router_dns", "fail", burst_num=i+1)
        matrix.record_diagnosis_outcome("dns", "ok", burst_num=5)

        diagnosis = {"culprit": "router_dns", "confidence": 0.90}
        matrix_confidence = matrix.calculate_confidence("router_dns")

        # Both should be high
        self.assertGreater(diagnosis["confidence"], 0.85)
        self.assertGreater(matrix_confidence, 0.85)
        self.assertLess(abs(diagnosis["confidence"] - matrix_confidence), 0.15,
                       "Diagnostic tree and matrix should be in agreement")

    def test_recommendation_uses_both_diagnosis_and_matrix(self):
        """Generate recommendation that uses:
        1. Current diagnosis (what's broken now)
        2. Matrix history (what was most impactful)
        3. Applied fixes (what's already been tried)"""
        matrix = diagnose.ConfigurationMatrix()
        matrix.record_test("wifi_mode", "802.11ac", "fail", error_count=14)
        matrix.record_test("router_dpi", "enabled", "ok")
        # wifi_mode=802.11ax untested

        diagnosis = {
            "anomalies": ["wifi_mode_pinned"],
            "culprit": None,
            "note": "no_network_culprit_but_wifi_suboptimal"
        }

        recommendation = diagnose.generate_recommendation(diagnosis, matrix)
        self.assertEqual(recommendation["primary"], "wifi_mode",
                        "Most impactful untested = primary recommendation")
        self.assertEqual(recommendation["confidence"], "high",
                        "High confidence due to high error correlation")


class ConfigurationMatrixEdgeCasesTest(unittest.TestCase):
    """Criterion 7: Handle edge cases: missing data, contradictions, etc."""

    def test_empty_matrix_suggests_baseline_tests(self):
        """New machine, no tests run yet.
        Matrix should suggest: run baseline diagnostic (all layers)."""
        matrix = diagnose.ConfigurationMatrix()
        suggestion = matrix.suggest_next_test()

        self.assertIn("baseline", suggestion.get("type", "").lower(),
                     "Empty matrix should suggest baseline")

    def test_all_tests_ok_suggests_nothing_urgent(self):
        """All configurations tested, all ok.
        No errors occurring.
        Suggestion: monitoring is sufficient."""
        matrix = diagnose.ConfigurationMatrix()
        matrix.record_test("wifi_mode", "802.11ax", "ok")
        matrix.record_test("router_dns", "ok", "ok")
        matrix.record_test("modem", "ok", "ok")

        suggestion = matrix.suggest_next_test()
        self.assertIn("monitor", suggestion.get("action", "").lower(),
                     "Should suggest continue monitoring")

    def test_contradictory_test_results_handled(self):
        """Tested wifi_mode=802.11ax: outcome=ok (0 errors).
        But separately: errors still occurring during monitoring.
        Explanation: Wi-Fi mode not the cause (or not the only cause)."""
        matrix = diagnose.ConfigurationMatrix()
        matrix.record_test("wifi_mode", "802.11ax", "ok", error_count=0)
        # But errors recorded in same period
        matrix.note_errors_during_test("wifi_mode", "802.11ax", error_count=5)

        record = matrix.get_test_record("wifi_mode", "802.11ax")
        self.assertEqual(record["unexpected_outcome"], True,
                        "Should flag contradiction")
        self.assertIn("inconclusive", record.get("note", "").lower(),
                     "Result is inconclusive")

    def test_incomplete_test_data_handled_safely(self):
        """Recorded test but missing error count.
        Should not crash, should note data is incomplete."""
        matrix = diagnose.ConfigurationMatrix()
        matrix.record_test("wifi_mode", "802.11ax", outcome="ok")
        # No error_count provided

        record = matrix.get_test_record("wifi_mode", "802.11ax")
        self.assertIsNone(record.get("error_count"))
        self.assertEqual(record.get("data_complete"), False,
                        "Should flag incomplete data")


if __name__ == "__main__":
    unittest.main()
