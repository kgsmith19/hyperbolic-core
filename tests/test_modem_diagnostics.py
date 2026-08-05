"""Modem diagnostics tests: signal levels, bridge mode, DOCSIS errors."""
import unittest
from netcheck import modem_diagnostics


class ModemIPDetectionTest(unittest.TestCase):
    """Tests for modem IP detection and reachability."""

    def test_bridge_mode_detection_returns_dict(self):
        """Bridge mode check returns proper diagnostic dict."""
        result = modem_diagnostics.check_bridge_mode()
        self.assertIsInstance(result, dict)
        self.assertIn('bridge_mode_detected', result)

    def test_wan_ip_detection(self):
        """WAN IP detection returns string or None."""
        ip = modem_diagnostics.detect_wan_ip()
        self.assertTrue(ip is None or isinstance(ip, str))

    def test_modem_diagnostics_has_required_methods(self):
        """ModemDiagnostics has all detection methods."""
        diag = modem_diagnostics.ModemDiagnostics()
        self.assertTrue(callable(diag.detect_modem_reachable))
        self.assertTrue(callable(diag.detect_signal_levels))
        self.assertTrue(callable(diag.detect_bridge_mode))

    def test_signal_level_detection_returns_dict(self):
        """Signal level detection returns diagnostic dict."""
        diag = modem_diagnostics.ModemDiagnostics()
        result = diag.detect_signal_levels()
        self.assertIsInstance(result, dict)
        self.assertIn('detected', result)

    def test_uncorrectable_codewords_detection(self):
        """Uncorrectable codeword detection returns dict."""
        diag = modem_diagnostics.ModemDiagnostics()
        result = diag.detect_uncorrectable_codewords()
        self.assertIsInstance(result, dict)
        self.assertIn('detected', result)


if __name__ == "__main__":
    unittest.main()
