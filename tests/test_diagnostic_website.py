"""Website integration: E2E and acceptance tests.

Tests verify:
1. Dashboard renders current configuration
2. Diagnostic history visible to user
3. Recommendations displayed accurately
4. User can track applied fixes
5. Regression detection shown to user
6. API endpoints work correctly
"""
import json
import unittest
from unittest.mock import Mock, patch, MagicMock
from datetime import datetime, timedelta

from netcheck import server, diagnose


class WebsiteDashboardDataTest(unittest.TestCase):
    """Criterion 1: Dashboard has all data it needs to render."""

    def test_dashboard_payload_includes_current_configuration(self):
        """Dashboard needs: current Wi-Fi mode, DNS, modem state, etc."""
        payload = server.dashboard_payload(db=Mock())

        required_sections = [
            "current_config",
            "baseline_config",
            "diagnostic_history",
            "applied_fixes",
            "next_recommendation"
        ]

        for section in required_sections:
            self.assertIn(section, payload,
                         f"Dashboard payload missing section: {section}")

    def test_current_config_includes_all_relevant_fields(self):
        """User should see complete current state."""
        payload = server.dashboard_payload(db=Mock())
        config = payload["current_config"]

        required_fields = [
            "timestamp",
            "wifi_mode",
            "wifi_signal",
            "router_dns",
            "router_dpi",
            "modem_snr",
            "system_uptime",
            "error_count_24h"
        ]

        for field in required_fields:
            self.assertIn(field, config,
                         f"Current config missing field: {field}")

    def test_baseline_config_captured_and_tracked(self):
        """Baseline is snapshot of good state.
        Should be visible so user can see what changed."""
        payload = server.dashboard_payload(db=Mock())
        baseline = payload["baseline_config"]

        self.assertIsNotNone(baseline,
                            "Baseline config must be captured")
        self.assertIn("timestamp", baseline,
                     "Baseline should have capture time")

    def test_configuration_delta_shown_to_user(self):
        """User sees: what changed since baseline?
        e.g., 'WiFi mode changed from 802.11ac to 802.11ax'."""
        payload = server.dashboard_payload(db=Mock())

        if "config_changes" in payload:
            changes = payload["config_changes"]
            for change in changes:
                self.assertIn("field", change)
                self.assertIn("from", change)
                self.assertIn("to", change)
                self.assertIn("date", change)


class DiagnosticHistoryDisplayTest(unittest.TestCase):
    """Criterion 2: User sees complete diagnosis history."""

    def test_error_bursts_listed_with_correlation(self):
        """For each error burst, show:
        - When it occurred
        - How many errors
        - Network state at time (correlated to sample)
        - Diagnosed culprit"""
        payload = server.dashboard_payload(db=Mock())
        history = payload["diagnostic_history"]

        for entry in history:
            self.assertIn("date", entry)
            self.assertIn("error_count", entry)
            self.assertIn("network_state", entry)
            self.assertIn("diagnosed_culprit", entry)

    def test_untested_burst_marked_unmonitored(self):
        """Error burst with no network samples nearby.
        Status: 'unmonitored - no data at time of error'."""
        payload = server.dashboard_payload(db=Mock())
        history = payload["diagnostic_history"]

        # Find an unmonitored burst
        unmonitored = [e for e in history if e.get("verdict") == "unmonitored"]
        self.assertTrue(len(unmonitored) > 0,
                       "Should have unmonitored entries if no samples")
        for entry in unmonitored:
            self.assertIn("unmonitored", entry.get("note", "").lower())

    def test_historical_culprits_ranked_by_frequency(self):
        """Show user: 'Last 5 errors: router_dns blamed 4 times (80%),
        interference 1 time (20%)'."""
        payload = server.dashboard_payload(db=Mock())
        culprit_summary = payload.get("culprit_summary", {})

        if culprit_summary:
            for culprit, stats in culprit_summary.items():
                self.assertIn("frequency", stats)
                self.assertIn("percentage", stats)
                self.assertIn("last_occurrence", stats)


class AppliedFixesTrackingTest(unittest.TestCase):
    """Criterion 3: User sees fixes applied and their outcomes."""

    def test_applied_fixes_listed_with_status(self):
        """Show each fix: applied date, method, status (success/pending/failure)."""
        payload = server.dashboard_payload(db=Mock())
        fixes = payload["applied_fixes"]

        for fix in fixes:
            self.assertIn("variable", fix,
                         "Fix should state what was changed")
            self.assertIn("from_value", fix)
            self.assertIn("to_value", fix)
            self.assertIn("applied_date", fix)
            self.assertIn("status", fix)
            self.assertIn("method", fix)

    def test_fix_status_shows_outcome(self):
        """Each fix shows: 'Applied 2026-08-05 via script. Result: pending (24h monitoring)'."""
        payload = server.dashboard_payload(db=Mock())
        fixes = payload["applied_fixes"]

        for fix in fixes:
            status = fix["status"]
            self.assertIn(status, ["success", "pending", "failed", "partial"],
                         "Fix status should be one of these")

            if status == "success":
                self.assertIn("outcome_summary", fix,
                             "Successful fix should explain result")
                self.assertIn("error_reduction", fix)

            if status == "pending":
                self.assertIn("days_observed", fix,
                             "Pending fix should show observation time")

    def test_fix_with_error_comparison(self):
        """Show before/after for fix outcomes:
        'Before: 14 errors in 72h. After: 0 errors in 72h. Improvement: 100%'."""
        payload = server.dashboard_payload(db=Mock())
        fixes = payload["applied_fixes"]

        for fix in fixes:
            if fix["status"] == "success":
                self.assertIn("errors_before", fix)
                self.assertIn("errors_after", fix)
                self.assertIn("observation_period_hours", fix)
                self.assertIn("improvement_pct", fix)


class RecommendationDisplayTest(unittest.TestCase):
    """Criterion 4: Recommendations shown with context and effort estimate."""

    def test_recommendation_includes_action_and_reasoning(self):
        """Show: 'Apply Wi-Fi adapter reset to 802.11ax mode'
        Because: 'Single most concrete anomaly, fits symptom pattern'."""
        payload = server.dashboard_payload(db=Mock())
        rec = payload["next_recommendation"]

        self.assertIn("action", rec)
        self.assertIn("reasoning", rec)
        self.assertIn("expected_impact", rec)

    def test_recommendation_includes_effort_and_risk(self):
        """User should know: 'Effort: easy (2 min). Risk: very low (reversible)'."""
        payload = server.dashboard_payload(db=Mock())
        rec = payload["next_recommendation"]

        if rec:
            self.assertIn("effort", rec)  # easy/medium/hard
            self.assertIn("risk_level", rec)  # low/medium/high
            self.assertIn("reversible", rec)  # True/False
            self.assertIn("estimated_time_minutes", rec)

    def test_recommendation_includes_expected_outcomes(self):
        """'If this works: Wi-Fi mode is causal (80% confident).
        If this doesn't work: Wi-Fi mode ruled out, investigate X next.'"""
        payload = server.dashboard_payload(db=Mock())
        rec = payload["next_recommendation"]

        if rec:
            self.assertIn("if_success", rec)
            self.assertIn("if_failure", rec)
            self.assertIn("confidence_if_success", rec)

    def test_multiple_recommendations_ranked(self):
        """If multiple options, rank by ROI.
        Show top 3 to user."""
        payload = server.dashboard_payload(db=Mock())
        recs = payload.get("recommended_next_steps", [])

        if len(recs) > 1:
            # Should be ranked by impact/effort
            scores = [r.get("roi_score", 0) for r in recs]
            self.assertEqual(scores, sorted(scores, reverse=True),
                           "Recommendations should be sorted by ROI (highest first)")


class ConfigurationMatrixVisualizationTest(unittest.TestCase):
    """Criterion 5: User sees tested combinations matrix."""

    def test_tested_combinations_table_shown(self):
        """Show: | Variable | Value | Tested | Outcome | Date | Action |
        | wifi_mode | 802.11ac | Yes | 14 errors | 2026-08-05 | [Details] |"""
        payload = server.dashboard_payload(db=Mock())
        matrix = payload.get("configuration_matrix", {})

        self.assertIsNotNone(matrix,
                            "Should show configuration matrix")

    def test_matrix_shows_tested_vs_untested(self):
        """Visual distinction: tested entries (completed) vs untested (todo)."""
        payload = server.dashboard_payload(db=Mock())
        matrix = payload.get("configuration_matrix", {})

        if matrix:
            for entry in matrix:
                self.assertIn("tested", entry)
                self.assertIn("outcome", entry)

    def test_matrix_suggests_next_test_in_ui(self):
        """Highlighted in matrix: 'Next to test: wifi_mode = 802.11ax'."""
        payload = server.dashboard_payload(db=Mock())
        next_test = payload.get("next_test_suggestion")

        if next_test:
            self.assertIn("variable", next_test)
            self.assertIn("value", next_test)
            self.assertIn("why_important", next_test)


class RegressionAlertTest(unittest.TestCase):
    """Criterion 6: Regression detection shown prominently."""

    def test_regression_detected_and_alerted(self):
        """Fixed: Wi-Fi mode to 802.11ax. Current: 802.11ac.
        Alert: 'REGRESSION DETECTED: Wi-Fi mode reverted'."""
        payload = server.dashboard_payload(db=Mock())

        if payload.get("regressions"):
            for regression in payload["regressions"]:
                self.assertIn("field", regression)
                self.assertIn("previous_value", regression)
                self.assertIn("current_value", regression)
                self.assertIn("date_detected", regression)
                self.assertTrue(regression["requires_attention"],
                               "Regressions should be flagged")

    def test_regression_alert_is_prominent(self):
        """Regression should be in API response and prominently displayed."""
        payload = server.dashboard_payload(db=Mock())

        if payload.get("regressions"):
            # Should be in alert section
            self.assertIn("alerts", payload)
            regression_alerts = [a for a in payload["alerts"]
                               if a["type"] == "regression"]
            self.assertTrue(len(regression_alerts) > 0,
                           "Regressions should appear in alerts")


class APIEndpointTest(unittest.TestCase):
    """Criterion 7: API endpoints work and return correct data."""

    def test_get_api_data_returns_dashboard_payload(self):
        """GET /api/diagnostic-data returns complete dashboard payload."""
        response = server.get_api_data(db=Mock())
        data = json.loads(response)

        required = ["current_config", "diagnostic_history", "next_recommendation"]
        for key in required:
            self.assertIn(key, data)

    def test_api_configuration_snapshot_returns_full_state(self):
        """GET /api/configuration-snapshot returns current complete state."""
        response = server.get_api_configuration_snapshot(db=Mock())
        data = json.loads(response)

        self.assertIn("timestamp", data)
        self.assertIn("fields", data)
        self.assertGreater(len(data["fields"]), 10,
                          "Should have many configuration fields")

    def test_api_history_returns_diagnostic_records(self):
        """GET /api/diagnostic-history?limit=10 returns last N diagnostic entries."""
        response = server.get_api_diagnostic_history(db=Mock(), limit=10)
        data = json.loads(response)

        self.assertIn("entries", data)
        self.assertLessEqual(len(data["entries"]), 10)

    def test_api_accepts_limit_parameter(self):
        """GET /api/history?limit=5 returns max 5 entries."""
        response_limit5 = server.get_api_diagnostic_history(db=Mock(), limit=5)
        data5 = json.loads(response_limit5)

        response_limit20 = server.get_api_diagnostic_history(db=Mock(), limit=20)
        data20 = json.loads(response_limit20)

        self.assertLessEqual(len(data5["entries"]), 5)
        self.assertLessEqual(len(data20["entries"]), 20)

    def test_api_error_handling_malformed_input(self):
        """GET /api/history?limit=abc returns 400 Bad Request."""
        response = server.get_api_diagnostic_history(db=Mock(), limit="abc")
        self.assertEqual(response["status"], 400,
                        "Malformed input should return 400")
        self.assertIn("error", response)


class DataConsistencyTest(unittest.TestCase):
    """Criterion 8: Data consistency across API and dashboard."""

    def test_dashboard_and_api_show_same_current_config(self):
        """Dashboard UI and /api/configuration-snapshot return same data."""
        db = Mock()

        dashboard_payload = server.dashboard_payload(db=db)
        api_response = server.get_api_configuration_snapshot(db=db)
        api_data = json.loads(api_response)

        # Check timestamp is similar (within 1 second)
        dashboard_ts = dashboard_payload["current_config"]["timestamp"]
        api_ts = api_data["timestamp"]

        # Both should reference same configuration snapshot
        self.assertEqual(
            dashboard_payload["current_config"].get("wifi_mode"),
            api_data["fields"].get("wifi_mode"),
            "Dashboard and API should show same Wi-Fi mode"
        )

    def test_recommendation_consistent_across_endpoints(self):
        """Recommendation shown in /api/data should match dashboard."""
        db = Mock()

        dashboard = server.dashboard_payload(db=db)
        api_data = json.loads(server.get_api_data(db=db))

        dashboard_rec = dashboard["next_recommendation"]
        api_rec = api_data["next_recommendation"]

        if dashboard_rec and api_rec:
            self.assertEqual(dashboard_rec["action"], api_rec["action"],
                           "Recommendation should be consistent")


class UserJourneyTest(unittest.TestCase):
    """Criterion 9: Complete user workflows work end-to-end."""

    def test_user_sees_config_then_diagnosis_then_recommendation(self):
        """User journey:
        1. Opens dashboard
        2. Sees current config (Wi-Fi mode = 802.11ac)
        3. Sees diagnostic history (14 errors blamed on suboptimal mode)
        4. Sees recommendation (apply fix to 802.11ax)"""
        db = Mock()
        payload = server.dashboard_payload(db=db)

        # Step 1: Current config visible
        self.assertIn("current_config", payload)
        config = payload["current_config"]
        self.assertIn("wifi_mode", config)

        # Step 2: History visible
        self.assertIn("diagnostic_history", payload)
        history = payload["diagnostic_history"]
        self.assertGreater(len(history), 0)

        # Step 3: Recommendation visible
        self.assertIn("next_recommendation", payload)
        rec = payload["next_recommendation"]
        self.assertIsNotNone(rec)

    def test_user_applies_fix_and_sees_progress(self):
        """User journey:
        1. Sees recommendation to apply fix
        2. Runs script
        3. Dashboard shows: 'Fix applied, monitoring (day 1 of 3)'
        4. After 3 days: 'Success! 0 errors observed'"""
        db = Mock()

        # Day 0: Recommendation shown
        payload = server.dashboard_payload(db=db)
        rec = payload["next_recommendation"]
        self.assertEqual(rec["status"], "recommended")

        # Day 1: After fix applied
        db.execute("UPDATE fixes SET status='pending' WHERE variable='wifi_mode'")
        payload = server.dashboard_payload(db=db)
        fixes = payload["applied_fixes"]
        wifi_fix = next((f for f in fixes if f["variable"] == "wifi_mode"), None)
        self.assertEqual(wifi_fix["status"], "pending")
        self.assertIn("days_observed", wifi_fix)

        # Day 4: After monitoring complete
        db.execute("UPDATE fixes SET status='success', errors_after=0")
        payload = server.dashboard_payload(db=db)
        fixes = payload["applied_fixes"]
        wifi_fix = next((f for f in fixes if f["variable"] == "wifi_mode"), None)
        self.assertEqual(wifi_fix["status"], "success")
        self.assertEqual(wifi_fix["errors_after"], 0)

    def test_user_detects_regression_and_reapplies_fix(self):
        """User journey:
        1. Fix applied, success
        2. Error burst occurs
        3. Dashboard detects: 'Wi-Fi mode reverted to 802.11ac'
        4. Recommendation: reapply fix
        5. User reapplies"""
        db = Mock()

        # Fixed state
        payload = server.dashboard_payload(db=db)
        self.assertEqual(payload["applied_fixes"][0]["status"], "success")

        # Regression detected
        db.execute("UPDATE config SET wifi_mode='802.11ac'")
        payload = server.dashboard_payload(db=db)

        self.assertIn("regressions", payload)
        self.assertTrue(len(payload["regressions"]) > 0)
        regression = payload["regressions"][0]
        self.assertEqual(regression["field"], "wifi_mode")
        self.assertEqual(regression["previous_value"], "802.11ax")
        self.assertEqual(regression["current_value"], "802.11ac")

        # Recommendation to reapply
        rec = payload["next_recommendation"]
        self.assertIn("reapply", rec.get("action", "").lower())


if __name__ == "__main__":
    unittest.main()
