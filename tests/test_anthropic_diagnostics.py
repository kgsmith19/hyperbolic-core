"""Anthropic status diagnostics tests. All network I/O mocked -- hermetic,
matching this project's own no-live-network-calls testing rule."""
import unittest
from unittest.mock import patch, MagicMock
from netcheck import anthropic_diagnostics


def _response(payload):
    resp = MagicMock()
    resp.read.return_value = payload
    resp.status = 200
    return resp


class AnthropicStatusTest(unittest.TestCase):
    def test_service_status_reports_degraded_on_major_outage(self):
        payload = b'{"status": {"description": "Major Outage", "indicator": "major_outage"}}'
        with patch("netcheck.anthropic_diagnostics.urlopen", return_value=_response(payload)):
            result = anthropic_diagnostics.AnthropicDiagnostics().check_service_status()
        self.assertTrue(result["service_degraded"])
        self.assertEqual(result["status_page_accessible"], True)

    def test_service_status_reports_normal_when_operational(self):
        payload = b'{"status": {"description": "All Systems Operational", "indicator": "none"}}'
        with patch("netcheck.anthropic_diagnostics.urlopen", return_value=_response(payload)):
            result = anthropic_diagnostics.AnthropicDiagnostics().check_service_status()
        self.assertFalse(result["service_degraded"])

    def test_service_status_unreachable_is_reported_not_raised(self):
        with patch("netcheck.anthropic_diagnostics.urlopen", side_effect=OSError("no route")):
            result = anthropic_diagnostics.AnthropicDiagnostics().check_service_status()
        self.assertFalse(result["status_page_accessible"])
        self.assertIsNone(result["service_degraded"])

    def test_api_connectivity_reachable(self):
        resp = _response(b"{}")
        with patch("netcheck.anthropic_diagnostics.urlopen", return_value=resp):
            result = anthropic_diagnostics.AnthropicDiagnostics().check_api_connectivity()
        self.assertTrue(result["api_reachable"])
        self.assertEqual(result["status_code"], 200)

    def test_api_connectivity_unreachable(self):
        with patch("netcheck.anthropic_diagnostics.urlopen", side_effect=OSError("timed out")):
            result = anthropic_diagnostics.AnthropicDiagnostics().check_api_connectivity()
        self.assertFalse(result["api_reachable"])

    def test_incident_history_counts_only_active_incidents(self):
        payload = (b'{"incidents": ['
                   b'{"status": "investigating"}, {"status": "resolved"}, '
                   b'{"status": "monitoring"}]}')
        with patch("netcheck.anthropic_diagnostics.urlopen", return_value=_response(payload)):
            result = anthropic_diagnostics.AnthropicDiagnostics().check_incident_history()
        self.assertEqual(result["recent_incidents"], 2)


if __name__ == "__main__":
    unittest.main()
