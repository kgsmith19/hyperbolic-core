"""Phase 22: Tests for unified all-diagnostics runner."""
import threading
import unittest
from unittest.mock import patch
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


class RunAllConcurrencyTest(unittest.TestCase):
    """The 7 phases are independent I/O -- run_all() must run them
    concurrently rather than one after another."""

    def test_phases_run_concurrently(self):
        runner = all_diagnostics.AllDiagnostics()
        barrier = threading.Barrier(7, timeout=1)

        def make_phase(name):
            def _run():
                # Only releases once all 7 phases have reached this line at
                # the same time -- impossible if run_all() called them one
                # at a time, since a lone caller would time out waiting.
                barrier.wait()
                return {"hypothesis": name}
            return _run

        with patch.object(runner, "run_phase_16_modem", make_phase("modem")), \
             patch.object(runner, "run_phase_17_nat", make_phase("nat")), \
             patch.object(runner, "run_phase_18_cgnat", make_phase("cgnat")), \
             patch.object(runner, "run_phase_19_anthropic", make_phase("anthropic")), \
             patch.object(runner, "run_phase_20_interference", make_phase("interference")), \
             patch.object(runner, "run_phase_21_router", make_phase("router")), \
             patch.object(runner, "run_phase_15_wifi", make_phase("wifi")):
            result = runner.run_all()

        self.assertEqual(len(result), 7)

    def test_run_all_preserves_phase_keys_and_values_under_concurrency(self):
        runner = all_diagnostics.AllDiagnostics()
        with patch.object(runner, "run_phase_16_modem", return_value={"hypothesis": "modem"}), \
             patch.object(runner, "run_phase_17_nat", return_value={"hypothesis": "nat"}), \
             patch.object(runner, "run_phase_18_cgnat", return_value={"hypothesis": "cgnat"}), \
             patch.object(runner, "run_phase_19_anthropic", return_value={"hypothesis": "anthropic"}), \
             patch.object(runner, "run_phase_20_interference", return_value={"hypothesis": "interference"}), \
             patch.object(runner, "run_phase_21_router", return_value={"hypothesis": "router"}), \
             patch.object(runner, "run_phase_15_wifi", return_value={"hypothesis": "wifi"}):
            result = runner.run_all()

        self.assertEqual(result["phase_16_modem"], {"hypothesis": "modem"})
        self.assertEqual(result["phase_17_nat"], {"hypothesis": "nat"})
        self.assertEqual(result["phase_18_cgnat"], {"hypothesis": "cgnat"})
        self.assertEqual(result["phase_19_anthropic"], {"hypothesis": "anthropic"})
        self.assertEqual(result["phase_20_interference"], {"hypothesis": "interference"})
        self.assertEqual(result["phase_21_router"], {"hypothesis": "router"})
        self.assertEqual(result["phase_15_wifi"], {"hypothesis": "wifi"})


if __name__ == "__main__":
    unittest.main()
