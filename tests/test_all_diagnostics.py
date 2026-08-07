"""Phase 22: Tests for the unified all-diagnostics runner."""
import threading
import unittest
from unittest.mock import patch
from netcheck import all_diagnostics, modem_diagnostics


class PhaseWiringTest(unittest.TestCase):
    """run_phase() threads a class instance's real method return values into
    the output dict -- not just that the keys exist, but that a changed
    value actually flows through. Testing the shared function once (with a
    synthetic entry) covers all 7 declarative PHASES entries; they all go
    through this same code, which is the point of collapsing them into it."""

    def test_reflects_the_instance_methods_actual_return_values(self):
        entry = ("phase_test", "test hypothesis", modem_diagnostics.ModemDiagnostics,
                 (("modem_reachable", "detect_modem_reachable"),
                  ("signal_levels", "detect_signal_levels")))
        with patch("netcheck.modem_diagnostics.ModemDiagnostics.detect_modem_reachable",
                   return_value={"reachable": True, "ip": "203.0.113.9"}), \
             patch("netcheck.modem_diagnostics.ModemDiagnostics.detect_signal_levels",
                   return_value={"detected": True, "snr_db": 41.0}):
            result = all_diagnostics.run_phase(entry)
        self.assertEqual(result["hypothesis"], "test hypothesis")
        self.assertEqual(result["modem_reachable"]["ip"], "203.0.113.9")
        self.assertEqual(result["signal_levels"]["snr_db"], 41.0)

    def test_phases_table_has_all_seven_and_no_duplicate_keys(self):
        keys = [entry[0] for entry in all_diagnostics.PHASES]
        self.assertEqual(len(keys), 7)
        self.assertEqual(len(keys), len(set(keys)), "duplicate phase key would silently clobber a result")


class QuickDiagnosisWarningTest(unittest.TestCase):
    """get_quick_diagnosis()'s WARNING lines must key off the field the
    underlying diagnostics class actually returns. Regression coverage for a
    real bug found in this pass: the CGNAT branch read result['is_cgnat'],
    but CGNATDiagnostics.detect_cgnat() returns 'detected' -- the warning
    could never fire, CGNAT or not."""

    def _results(self, double_nat=False, cgnat=False):
        return {
            "phase_16_modem": {"hypothesis": "m"},
            "phase_17_nat": {"hypothesis": "n", "double_nat": {"detected": double_nat}},
            "phase_18_cgnat": {"hypothesis": "c", "cgnat_detected": {"detected": cgnat}},
            "phase_19_anthropic": {"hypothesis": "a", "service_status": {}},
            "phase_20_interference": {"hypothesis": "i"},
            "phase_21_router": {"hypothesis": "r"},
            "phase_15_wifi": {"hypothesis": "w"},
        }

    def test_cgnat_warning_fires_when_detected(self):
        with patch.object(all_diagnostics.AllDiagnostics, "run_all",
                          return_value=self._results(cgnat=True)):
            summary = all_diagnostics.AllDiagnostics().get_quick_diagnosis()
        self.assertIn("WARNING: Carrier-Grade NAT detected", summary)

    def test_double_nat_warning_fires_when_detected(self):
        with patch.object(all_diagnostics.AllDiagnostics, "run_all",
                          return_value=self._results(double_nat=True)):
            summary = all_diagnostics.AllDiagnostics().get_quick_diagnosis()
        self.assertIn("WARNING: Double NAT detected", summary)

    def test_no_warnings_when_nothing_detected(self):
        with patch.object(all_diagnostics.AllDiagnostics, "run_all",
                          return_value=self._results()):
            summary = all_diagnostics.AllDiagnostics().get_quick_diagnosis()
        self.assertNotIn("WARNING", summary)


class RunAllConcurrencyTest(unittest.TestCase):
    """The 7 phases are independent I/O -- run_all() must run them
    concurrently rather than one after another."""

    def test_phases_run_concurrently(self):
        barrier = threading.Barrier(7, timeout=1)

        def fake_run_phase(entry):
            # Only releases once all 7 submitted calls have reached this line
            # at the same time -- impossible if run_all() called them one at
            # a time, since a lone caller would time out waiting.
            barrier.wait()
            return {"hypothesis": entry[0]}

        with patch("netcheck.all_diagnostics.run_phase", side_effect=fake_run_phase):
            result = all_diagnostics.AllDiagnostics().run_all()

        self.assertEqual(len(result), 7)

    def test_run_all_preserves_phase_keys_and_values_under_concurrency(self):
        with patch("netcheck.all_diagnostics.run_phase",
                   side_effect=lambda entry: {"hypothesis": entry[0]}):
            result = all_diagnostics.AllDiagnostics().run_all()

        for entry in all_diagnostics.PHASES:
            key = entry[0]
            self.assertEqual(result[key], {"hypothesis": key})


if __name__ == "__main__":
    unittest.main()
