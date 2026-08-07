"""CGNAT diagnostics tests. WAN-IP lookups mocked -- hermetic."""
import unittest
from unittest.mock import patch
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
    """Tests for CGNAT diagnostics, with the WAN-IP lookup mocked."""

    def test_cgnat_detected_when_wan_ip_in_range(self):
        with patch("netcheck.cgnat_diagnostics.get_wan_ip", return_value="100.70.1.1"):
            result = cgnat_diagnostics.CGNATDiagnostics().detect_cgnat()
        self.assertTrue(result["detected"])
        self.assertEqual(result["wan_ip"], "100.70.1.1")

    def test_not_cgnat_when_wan_ip_outside_range(self):
        with patch("netcheck.cgnat_diagnostics.get_wan_ip", return_value="203.0.113.5"):
            result = cgnat_diagnostics.CGNATDiagnostics().detect_cgnat()
        self.assertFalse(result["detected"])

    def test_cgnat_implications_listed_only_when_active(self):
        with patch("netcheck.cgnat_diagnostics.get_wan_ip", return_value="100.70.1.1"):
            result = cgnat_diagnostics.CGNATDiagnostics().check_cgnat_implications()
        self.assertTrue(result["cgnat_active"])
        self.assertTrue(result["implications"])

        with patch("netcheck.cgnat_diagnostics.get_wan_ip", return_value="203.0.113.5"):
            result = cgnat_diagnostics.CGNATDiagnostics().check_cgnat_implications()
        self.assertFalse(result["cgnat_active"])
        self.assertEqual(result["implications"], [])


if __name__ == "__main__":
    unittest.main()
