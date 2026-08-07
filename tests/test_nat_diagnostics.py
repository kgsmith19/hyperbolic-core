"""NAT diagnostics tests: double NAT, NAT type detection."""
import unittest
from unittest.mock import patch, MagicMock
from netcheck import nat_diagnostics, cgnat_diagnostics


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
    """Tests for double NAT detection, with local/WAN IP lookups mocked."""

    def test_double_nat_detected_when_wan_ip_is_private(self):
        with patch("netcheck.nat_diagnostics.get_local_ip", return_value="192.168.1.5"), \
             patch("netcheck.nat_diagnostics.get_wan_ip", return_value="10.0.0.1"):
            result = nat_diagnostics.detect_double_nat()
        self.assertTrue(result["detected"])
        self.assertEqual(result["local_ip"], "192.168.1.5")
        self.assertEqual(result["wan_ip"], "10.0.0.1")

    def test_single_nat_when_wan_ip_is_public(self):
        with patch("netcheck.nat_diagnostics.get_local_ip", return_value="192.168.1.5"), \
             patch("netcheck.nat_diagnostics.get_wan_ip", return_value="203.0.113.5"):
            result = nat_diagnostics.detect_double_nat()
        self.assertFalse(result["detected"])

    def test_nat_type_is_double_nat_when_wan_ip_private(self):
        with patch("netcheck.nat_diagnostics.get_wan_ip", return_value="10.0.0.1"):
            result = nat_diagnostics.NATDiagnostics().detect_nat_type()
        self.assertEqual(result["nat_type"], "double_nat")

    def test_nat_type_is_standard_when_wan_ip_public(self):
        with patch("netcheck.nat_diagnostics.get_wan_ip", return_value="203.0.113.5"):
            result = nat_diagnostics.NATDiagnostics().detect_nat_type()
        self.assertEqual(result["nat_type"], "standard_nat")

    def test_network_topology_double_nat(self):
        with patch("netcheck.nat_diagnostics.get_local_ip", return_value="192.168.1.5"), \
             patch("netcheck.nat_diagnostics.get_wan_ip", return_value="10.0.0.1"):
            result = nat_diagnostics.NATDiagnostics().get_network_topology()
        self.assertEqual(result["topology"], "double_nat")


class WanIpCachingTest(unittest.TestCase):
    """nat_diagnostics and cgnat_diagnostics both need the WAN IP; they should
    share one cached lookup instead of hitting api.ipify.org twice per run."""

    def setUp(self):
        nat_diagnostics.get_wan_ip.cache_clear()

    def test_cgnat_get_wan_ip_reuses_nat_diagnostics_cache(self):
        response = MagicMock()
        response.read.return_value = b'{"ip": "203.0.113.5"}'
        with patch("netcheck.nat_diagnostics.urlopen", return_value=response) as mock_open:
            self.assertEqual(nat_diagnostics.get_wan_ip(), "203.0.113.5")
            self.assertEqual(cgnat_diagnostics.get_wan_ip(), "203.0.113.5")

        mock_open.assert_called_once()


if __name__ == "__main__":
    unittest.main()
