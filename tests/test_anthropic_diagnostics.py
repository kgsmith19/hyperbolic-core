import unittest
from netcheck import anthropic_diagnostics

class AnthropicStatusTest(unittest.TestCase):
    def test_service_status_returns_dict(self):
        diag = anthropic_diagnostics.AnthropicDiagnostics()
        result = diag.check_service_status()
        self.assertIsInstance(result, dict)
        self.assertIn('status_page_accessible', result)

    def test_api_connectivity_check(self):
        diag = anthropic_diagnostics.AnthropicDiagnostics()
        result = diag.check_api_connectivity()
        self.assertIsInstance(result, dict)
        self.assertIn('api_reachable', result)

    def test_incident_history_check(self):
        diag = anthropic_diagnostics.AnthropicDiagnostics()
        result = diag.check_incident_history()
        self.assertIsInstance(result, dict)
        self.assertIn('recent_incidents', result)

if __name__ == "__main__":
    unittest.main()
