"""NAT diagnostics tests: double NAT, NAT type detection."""
import unittest
from netcheck import nat_diagnostics


class PrivateIPDetectionTest(unittest.TestCase):
    """Tests for private IP range detection."""

    def test_private_ranges_detected(self):
        """Private IP ranges are correctly identified."""
        private_ips = [
            "10.0.0.1",
            "10.255.255.255",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.0.1",
            "192.168.255.255",
        ]
        for ip in private_ips:
            self.assertTrue(nat_diagnostics.is_private_ip(ip), f"{ip} should be private")

    def test_public_ips_not_detected(self):
        """Public IPs are not marked as private."""
        public_ips = [
            "8.8.8.8",
            "1.1.1.1",
            "100.65.0.1",  # Just outside CGNAT
        ]
        for ip in public_ips:
            self.assertFalse(nat_diagnostics.is_private_ip(ip), f"{ip} should be public")

    def test_invalid_ips_handled(self):
        """Invalid IPs don't crash detection."""
        self.assertFalse(nat_diagnostics.is_private_ip("invalid"))
        self.assertFalse(nat_diagnostics.is_private_ip("192.168"))
        self.assertFalse(nat_diagnostics.is_private_ip(""))
        self.assertFalse(nat_diagnostics.is_private_ip(None))


class DoubleNATDetectionTest(unittest.TestCase):
    """Tests for double NAT detection."""

    def test_double_nat_detection_returns_dict(self):
        """Double NAT detection returns proper diagnostic dict."""
        result = nat_diagnostics.detect_double_nat()
        self.assertIsInstance(result, dict)
        self.assertIn('detected', result)
        self.assertIn('local_ip', result)
        self.assertIn('wan_ip', result)

    def test_nat_diagnostics_has_required_methods(self):
        """NATDiagnostics has all detection methods."""
        diag = nat_diagnostics.NATDiagnostics()
        self.assertTrue(callable(diag.detect_double_nat))
        self.assertTrue(callable(diag.detect_nat_type))
        self.assertTrue(callable(diag.get_network_topology))

    def test_nat_type_detection_returns_type(self):
        """NAT type detection returns classification."""
        diag = nat_diagnostics.NATDiagnostics()
        result = diag.detect_nat_type()
        self.assertIsInstance(result, dict)
        self.assertIn('nat_type', result)

    def test_network_topology_detection(self):
        """Network topology detection returns topology string."""
        diag = nat_diagnostics.NATDiagnostics()
        result = diag.get_network_topology()
        self.assertIsInstance(result, dict)
        self.assertIn('topology', result)


if __name__ == "__main__":
    unittest.main()
