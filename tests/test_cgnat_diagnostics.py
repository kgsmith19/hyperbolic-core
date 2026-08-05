"""CGNAT diagnostics tests: CGNAT detection."""
import unittest
from netcheck import cgnat_diagnostics


class CGNATIPDetectionTest(unittest.TestCase):
    """Tests for CGNAT IP range detection."""

    def test_cgnat_range_detected(self):
        """CGNAT IP range (100.64-127.x.x.x) is detected."""
        cgnat_ips = [
            "100.64.0.0",
            "100.64.0.1",
            "100.127.255.255",
            "100.95.128.1",
        ]
        for ip in cgnat_ips:
            self.assertTrue(cgnat_diagnostics.is_cgnat_ip(ip), f"{ip} should be CGNAT")

    def test_outside_cgnat_range_not_detected(self):
        """IPs outside CGNAT range are not flagged."""
        non_cgnat_ips = [
            "100.63.255.255",  # Just before CGNAT
            "100.128.0.0",      # Just after CGNAT
            "8.8.8.8",
            "192.168.1.1",
        ]
        for ip in non_cgnat_ips:
            self.assertFalse(cgnat_diagnostics.is_cgnat_ip(ip), f"{ip} should not be CGNAT")

    def test_invalid_ips_handled(self):
        """Invalid IPs don't crash detection."""
        self.assertFalse(cgnat_diagnostics.is_cgnat_ip("invalid"))
        self.assertFalse(cgnat_diagnostics.is_cgnat_ip(""))
        self.assertFalse(cgnat_diagnostics.is_cgnat_ip(None))


class CGNATDiagnosticsTest(unittest.TestCase):
    """Tests for CGNAT diagnostics."""

    def test_cgnat_detection_returns_dict(self):
        """CGNAT detection returns proper diagnostic dict."""
        diag = cgnat_diagnostics.CGNATDiagnostics()
        result = diag.detect_cgnat()
        self.assertIsInstance(result, dict)
        self.assertIn('detected', result)

    def test_cgnat_implications_returned(self):
        """CGNAT implications check returns guidance."""
        diag = cgnat_diagnostics.CGNATDiagnostics()
        result = diag.check_cgnat_implications()
        self.assertIsInstance(result, dict)
        self.assertIn('cgnat_active', result)
        self.assertIn('implications', result)

    def test_cgnat_diagnostics_has_methods(self):
        """CGNATDiagnostics has required methods."""
        diag = cgnat_diagnostics.CGNATDiagnostics()
        self.assertTrue(callable(diag.detect_cgnat))
        self.assertTrue(callable(diag.check_cgnat_implications))


if __name__ == "__main__":
    unittest.main()
