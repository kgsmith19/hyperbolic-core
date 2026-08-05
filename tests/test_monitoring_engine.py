"""Regression monitoring: detect issue recurrence and new problems.

PDD: Monitoring results track regression state and confidence.
SDD: Regression detection identifies culprit return and new issues.
TDD: Monitoring integrates historical data to predict future regressions.
"""
import unittest
from datetime import datetime, timedelta
from netcheck import monitoring_engine


class MonitoringScheduleTest(unittest.TestCase):
    """PDD: Monitoring schedule has required fields."""

    def test_schedule_creates_monitor_id(self):
        """Schedule returns unique monitor ID."""
        schedule = monitoring_engine.schedule_periodic_monitoring(1)
        self.assertIn("monitor_id", schedule)
        self.assertTrue(schedule["monitor_id"].startswith("monitor_"))

    def test_schedule_sets_interval(self):
        """Schedule stores requested interval."""
        for hours in [1, 2, 4, 24]:
            schedule = monitoring_engine.schedule_periodic_monitoring(hours)
            self.assertEqual(schedule["interval_hours"], hours)

    def test_schedule_next_check_is_future(self):
        """Next check is scheduled in the future."""
        schedule = monitoring_engine.schedule_periodic_monitoring(1)
        next_check = datetime.fromisoformat(schedule["next_check"])
        self.assertGreater(next_check, datetime.now())

    def test_schedule_starts_empty_snapshots(self):
        """Monitoring starts with no snapshots."""
        schedule = monitoring_engine.schedule_periodic_monitoring(1)
        self.assertEqual(len(schedule["snapshots"]), 0)


class RegressionDetectionBasicsTest(unittest.TestCase):
    """SDD: Regression detection identifies issue return."""

    def test_regression_detected_culprit_returned(self):
        """Regression when same culprit appears again."""
        baseline = {"primary_culprit": "wifi", "synthesis_confidence": 0.05}
        current = {"primary_culprit": "wifi", "synthesis_confidence": 0.75}

        result = monitoring_engine.detect_regression(baseline, current)

        self.assertTrue(result["regression_detected"])
        self.assertEqual(result["culprit"], "wifi")

    def test_no_regression_when_healthy(self):
        """No regression when network stays healthy."""
        baseline = {"primary_culprit": None, "synthesis_confidence": 0.05}
        current = {"primary_culprit": None, "synthesis_confidence": 0.05}

        result = monitoring_engine.detect_regression(baseline, current)

        self.assertFalse(result["regression_detected"])

    def test_new_issue_detected(self):
        """New issue when different culprit appears."""
        baseline = {"primary_culprit": None, "synthesis_confidence": 0.05}
        current = {"primary_culprit": "router", "synthesis_confidence": 0.80}

        result = monitoring_engine.detect_regression(baseline, current)

        self.assertTrue(result["culprit"])
        self.assertEqual(result["alert"], "New issue: router at 80% confidence")

    def test_culprit_change_detected(self):
        """Issue change when culprit switches."""
        baseline = {"primary_culprit": "wifi", "synthesis_confidence": 0.8}
        current = {"primary_culprit": "router", "synthesis_confidence": 0.8}

        result = monitoring_engine.detect_regression(baseline, current)

        self.assertIn("changed", result["alert"])


class RegressionSeverityTest(unittest.TestCase):
    """PDD: Regression severity is accurately classified."""

    def test_high_severity_rapid_regression(self):
        """High severity for rapid confidence jump."""
        baseline = {"primary_culprit": "wifi", "synthesis_confidence": 0.1}
        current = {"primary_culprit": "wifi", "synthesis_confidence": 0.9}

        result = monitoring_engine.detect_regression(baseline, current)

        self.assertEqual(result["severity"], "high")
        self.assertTrue(result["regression_detected"])

    def test_medium_severity_moderate_regression(self):
        """Medium severity for moderate confidence increase."""
        baseline = {"primary_culprit": "wifi", "synthesis_confidence": 0.1}
        current = {"primary_culprit": "wifi", "synthesis_confidence": 0.6}

        result = monitoring_engine.detect_regression(baseline, current)

        self.assertEqual(result["severity"], "medium")

    def test_low_severity_healthy(self):
        """Low severity when network is healthy."""
        baseline = {"primary_culprit": "wifi", "synthesis_confidence": 0.8}
        current = {"primary_culprit": None, "synthesis_confidence": 0.05}

        result = monitoring_engine.detect_regression(baseline, current)

        self.assertEqual(result["severity"], "low")


class ConfidenceTrackingTest(unittest.TestCase):
    """PDD: Confidence changes are precisely tracked."""

    def test_confidence_increase_recorded(self):
        """Confidence increase is calculated."""
        baseline = {"primary_culprit": "wifi", "synthesis_confidence": 0.5}
        current = {"primary_culprit": "wifi", "synthesis_confidence": 0.85}

        result = monitoring_engine.detect_regression(baseline, current)

        self.assertAlmostEqual(result["confidence_increase"], 0.35, places=5)

    def test_confidence_decrease_recorded(self):
        """Confidence decrease is calculated."""
        baseline = {"primary_culprit": "wifi", "synthesis_confidence": 0.8}
        current = {"primary_culprit": "wifi", "synthesis_confidence": 0.2}

        result = monitoring_engine.detect_regression(baseline, current)

        self.assertAlmostEqual(result["confidence_increase"], -0.6, places=5)


class DiagnosisHistoryTrackingTest(unittest.TestCase):
    """TDD: History analysis identifies patterns in diagnosis data."""

    def test_history_empty_returns_defaults(self):
        """Empty history returns reasonable defaults."""
        history = monitoring_engine.track_diagnosis_history([])

        self.assertEqual(history["snapshot_count"], 0)
        self.assertEqual(len(history["culprits_observed"]), 0)

    def test_history_counts_snapshots(self):
        """History tracks number of samples."""
        snapshots = [
            {"primary_culprit": "wifi", "synthesis_confidence": 0.8},
            {"primary_culprit": None, "synthesis_confidence": 0.1},
            {"primary_culprit": "router", "synthesis_confidence": 0.7},
        ]

        history = monitoring_engine.track_diagnosis_history(snapshots)

        self.assertEqual(history["snapshot_count"], 3)

    def test_history_identifies_culprits(self):
        """History identifies all culprits observed."""
        snapshots = [
            {"primary_culprit": "wifi", "synthesis_confidence": 0.8},
            {"primary_culprit": "wifi", "synthesis_confidence": 0.75},
            {"primary_culprit": "router", "synthesis_confidence": 0.7},
        ]

        history = monitoring_engine.track_diagnosis_history(snapshots)

        self.assertIn("wifi", history["culprits_observed"])
        self.assertIn("router", history["culprits_observed"])

    def test_history_calculates_culprit_frequencies(self):
        """History counts culprit occurrences."""
        snapshots = [
            {"primary_culprit": "wifi", "synthesis_confidence": 0.8},
            {"primary_culprit": "wifi", "synthesis_confidence": 0.75},
            {"primary_culprit": "router", "synthesis_confidence": 0.7},
        ]

        history = monitoring_engine.track_diagnosis_history(snapshots)

        self.assertEqual(history["culprit_frequencies"]["wifi"], 2)
        self.assertEqual(history["culprit_frequencies"]["router"], 1)

    def test_history_trend_improving(self):
        """Improving trend when confidence decreases."""
        snapshots = [
            {"primary_culprit": "wifi", "synthesis_confidence": 0.9},
            {"primary_culprit": "wifi", "synthesis_confidence": 0.8},
            {"primary_culprit": "wifi", "synthesis_confidence": 0.3},
            {"primary_culprit": None, "synthesis_confidence": 0.1},
        ]

        history = monitoring_engine.track_diagnosis_history(snapshots)

        self.assertEqual(history["confidence_trend"], "improving")

    def test_history_trend_degrading(self):
        """Degrading trend when confidence increases."""
        snapshots = [
            {"primary_culprit": None, "synthesis_confidence": 0.1},
            {"primary_culprit": None, "synthesis_confidence": 0.15},
            {"primary_culprit": "wifi", "synthesis_confidence": 0.7},
            {"primary_culprit": "wifi", "synthesis_confidence": 0.9},
        ]

        history = monitoring_engine.track_diagnosis_history(snapshots)

        self.assertEqual(history["confidence_trend"], "degrading")

    def test_history_identifies_recurring_issues(self):
        """Recurring issues are flagged when appearing multiple times."""
        snapshots = [
            {"primary_culprit": "wifi", "synthesis_confidence": 0.8},
            {"primary_culprit": None, "synthesis_confidence": 0.1},
            {"primary_culprit": "wifi", "synthesis_confidence": 0.75},
        ]

        history = monitoring_engine.track_diagnosis_history(snapshots)

        self.assertGreater(len(history["issues"]), 0)


class RecurrencePredictionTest(unittest.TestCase):
    """TDD: Predict likelihood of issue recurrence."""

    def test_prediction_empty_history_conservative(self):
        """Empty history defaults to low recurrence."""
        prediction = monitoring_engine.predict_next_regression([], "wifi")

        self.assertLess(prediction["recurrence_probability"], 0.3)
        self.assertEqual(prediction["confidence"], "low")

    def test_prediction_high_recurrence(self):
        """High recurrence when issue appears frequently."""
        history = [
            {"primary_culprit": "wifi", "synthesis_confidence": 0.8},
            {"primary_culprit": "wifi", "synthesis_confidence": 0.75},
            {"primary_culprit": "wifi", "synthesis_confidence": 0.8},
        ]

        prediction = monitoring_engine.predict_next_regression(history, "wifi")

        self.assertGreater(prediction["recurrence_probability"], 0.5)
        self.assertEqual(prediction["confidence"], "high")

    def test_prediction_low_recurrence(self):
        """Low recurrence when issue rarely appears."""
        history = [
            {"primary_culprit": "wifi", "synthesis_confidence": 0.8},
            {"primary_culprit": None, "synthesis_confidence": 0.1},
            {"primary_culprit": None, "synthesis_confidence": 0.1},
            {"primary_culprit": "router", "synthesis_confidence": 0.7},
        ]

        prediction = monitoring_engine.predict_next_regression(history, "wifi")

        self.assertLess(prediction["recurrence_probability"], 0.3)

    def test_prediction_monitoring_intensity(self):
        """Monitoring intensity increases with recurrence risk."""
        high_risk = [
            {"primary_culprit": "wifi", "synthesis_confidence": 0.8},
            {"primary_culprit": "wifi", "synthesis_confidence": 0.8},
        ]
        low_risk = [
            {"primary_culprit": "wifi", "synthesis_confidence": 0.8},
            {"primary_culprit": None, "synthesis_confidence": 0.1},
            {"primary_culprit": None, "synthesis_confidence": 0.1},
            {"primary_culprit": None, "synthesis_confidence": 0.1},
            {"primary_culprit": None, "synthesis_confidence": 0.1},
        ]

        high_pred = monitoring_engine.predict_next_regression(high_risk, "wifi")
        low_pred = monitoring_engine.predict_next_regression(low_risk, "wifi")

        self.assertIn("Intensive", high_pred["monitoring_recommendation"])
        self.assertIn("Relaxed", low_pred["monitoring_recommendation"])


class ResultStructureTest(unittest.TestCase):
    """PDD: All monitoring results have complete structure."""

    def test_regression_result_has_all_fields(self):
        """Regression detection result is complete."""
        baseline = {"primary_culprit": "wifi", "synthesis_confidence": 0.1}
        current = {"primary_culprit": "wifi", "synthesis_confidence": 0.8}

        result = monitoring_engine.detect_regression(baseline, current)

        for field in ["regression_detected", "culprit", "confidence_increase",
                      "alert", "recommended_action", "severity", "timestamp"]:
            self.assertIn(field, result)

    def test_history_result_has_all_fields(self):
        """History tracking result is complete."""
        snapshots = [{"primary_culprit": "wifi", "synthesis_confidence": 0.8}]

        result = monitoring_engine.track_diagnosis_history(snapshots)

        for field in ["analysis_period_hours", "snapshot_count", "culprits_observed",
                      "culprit_frequencies", "confidence_trend", "issues", "pattern_summary"]:
            self.assertIn(field, result)

    def test_prediction_result_has_all_fields(self):
        """Prediction result is complete."""
        result = monitoring_engine.predict_next_regression([], "wifi")

        for field in ["fixed_culprit", "recurrence_probability", "predicted_recurrence_hours",
                      "confidence", "rationale", "monitoring_recommendation"]:
            self.assertIn(field, result)


class MonitoringReportTest(unittest.TestCase):
    """TDD: Complete monitoring report integrates all analyses."""

    def test_report_has_all_sections(self):
        """Report includes regression, history, and prediction."""
        baseline = {"primary_culprit": "wifi", "synthesis_confidence": 0.05}
        current = {"primary_culprit": None, "synthesis_confidence": 0.05}
        history = [baseline, current]

        report = monitoring_engine.generate_monitoring_report(baseline, current, history)

        self.assertIn("report_timestamp", report)
        self.assertIn("regression_status", report)
        self.assertIn("history_analysis", report)
        self.assertIn("recurrence_prediction", report)
        self.assertIn("overall_status", report)
        self.assertIn("next_recommended_check", report)

    def test_report_alert_status_regression(self):
        """Report indicates alert when regression detected."""
        baseline = {"primary_culprit": "wifi", "synthesis_confidence": 0.05}
        current = {"primary_culprit": "wifi", "synthesis_confidence": 0.85}
        history = []

        report = monitoring_engine.generate_monitoring_report(baseline, current, history)

        self.assertIn("ALERT", report["overall_status"])

    def test_report_warning_status_new_issue(self):
        """Report indicates warning for new issues."""
        baseline = {"primary_culprit": None, "synthesis_confidence": 0.05}
        current = {"primary_culprit": "router", "synthesis_confidence": 0.80}
        history = []

        report = monitoring_engine.generate_monitoring_report(baseline, current, history)

        self.assertIn("WARNING", report["overall_status"])

    def test_report_healthy_status(self):
        """Report indicates healthy when no issues."""
        baseline = {"primary_culprit": None, "synthesis_confidence": 0.05}
        current = {"primary_culprit": None, "synthesis_confidence": 0.05}
        history = []

        report = monitoring_engine.generate_monitoring_report(baseline, current, history)

        self.assertIn("HEALTHY", report["overall_status"])


if __name__ == "__main__":
    unittest.main()
