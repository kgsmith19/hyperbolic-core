"""Phase 22: Tests for unified all-diagnostics runner."""
import unittest
from netcheck import all_diagnostics


class AllDiagnosticsTest(unittest.TestCase):
    """Test the unified diagnostics runner."""

    def test_phase_16_modem_returns_dict(self):
        """Test modem diagnostics returns proper structure."""
        runner = all_diagnostics.AllDiagnostics()
        result = runner.run_phase_16_modem()
        self.assertIsInstance(result, dict)
        self.assertIn("hypothesis", result)
        self.assertIn("modem_reachable", result)
        self.assertIn("signal_levels", result)

    def test_phase_17_nat_returns_dict(self):
        """Test NAT diagnostics returns proper structure."""
        runner = all_diagnostics.AllDiagnostics()
        result = runner.run_phase_17_nat()
        self.assertIsInstance(result, dict)
        self.assertIn("hypothesis", result)
        self.assertIn("double_nat", result)
        self.assertIn("nat_type", result)

    def test_phase_18_cgnat_returns_dict(self):
        """Test CGNAT diagnostics returns proper structure."""
        runner = all_diagnostics.AllDiagnostics()
        result = runner.run_phase_18_cgnat()
        self.assertIsInstance(result, dict)
        self.assertIn("hypothesis", result)
        self.assertIn("cgnat_detected", result)

    def test_phase_19_anthropic_returns_dict(self):
        """Test Anthropic diagnostics returns proper structure."""
        runner = all_diagnostics.AllDiagnostics()
        result = runner.run_phase_19_anthropic()
        self.assertIsInstance(result, dict)
        self.assertIn("hypothesis", result)
        self.assertIn("service_status", result)
        self.assertIn("api_connectivity", result)

    def test_phase_20_interference_returns_dict(self):
        """Test interference diagnostics returns proper structure."""
        runner = all_diagnostics.AllDiagnostics()
        result = runner.run_phase_20_interference()
        self.assertIsInstance(result, dict)
        self.assertIn("hypothesis", result)
        self.assertIn("interference_sources", result)
        self.assertIn("channel_overlap", result)

    def test_phase_21_router_returns_dict(self):
        """Test router diagnostics returns proper structure."""
        runner = all_diagnostics.AllDiagnostics()
        result = runner.run_phase_21_router()
        self.assertIsInstance(result, dict)
        self.assertIn("hypothesis", result)
        self.assertIn("firmware", result)
        self.assertIn("qos_settings", result)
        self.assertIn("security_features", result)

    def test_phase_15_wifi_returns_dict(self):
        """Test WiFi diagnostics returns proper structure."""
        runner = all_diagnostics.AllDiagnostics()
        result = runner.run_phase_15_wifi()
        self.assertIsInstance(result, dict)
        self.assertIn("hypothesis", result)
        self.assertIn("band_steering", result)

    def test_run_all_returns_complete_results(self):
        """Test run_all returns results for all phases."""
        runner = all_diagnostics.AllDiagnostics()
        result = runner.run_all()
        self.assertIsInstance(result, dict)
        self.assertIn("phase_16_modem", result)
        self.assertIn("phase_17_nat", result)
        self.assertIn("phase_18_cgnat", result)
        self.assertIn("phase_19_anthropic", result)
        self.assertIn("phase_20_interference", result)
        self.assertIn("phase_21_router", result)
        self.assertIn("phase_15_wifi", result)

    def test_quick_diagnosis_returns_string(self):
        """Test quick diagnosis returns readable summary."""
        runner = all_diagnostics.AllDiagnostics()
        result = runner.get_quick_diagnosis()
        self.assertIsInstance(result, str)
        self.assertIn("Network Diagnostics Summary", result)
        self.assertIn("Modem", result)
        self.assertIn("NAT", result)


if __name__ == "__main__":
    unittest.main()
