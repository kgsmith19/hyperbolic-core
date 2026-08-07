"""Modem diagnostics tests: signal levels, bridge mode, DOCSIS errors.
Network/subprocess I/O mocked -- hermetic."""
import os
import unittest
from unittest.mock import patch, MagicMock
from urllib.error import URLError
from netcheck import modem_diagnostics


class ModemHostFromEnvTest(unittest.TestCase):
    """#33: the modem host must follow MODEM_HOST, never a hardcoded IP."""

    def test_uses_modem_host_env_var_when_set(self):
        with patch.dict(os.environ, {"MODEM_HOST": "10.8.8.8"}):
            self.assertEqual(modem_diagnostics.get_modem_host(), "10.8.8.8")
            self.assertEqual(modem_diagnostics.ModemDiagnostics().modem_ip, "10.8.8.8")

    def test_falls_back_to_environ_module_default_when_unset(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(modem_diagnostics.get_modem_host(),
                             modem_diagnostics.MODEM_HOST_DEFAULT)


class ModemIPDetectionTest(unittest.TestCase):
    """Tests for modem IP detection and reachability."""

    def test_bridge_mode_detected_from_single_gateway(self):
        """A single gateway in the routing table means no double NAT."""
        result_stub = MagicMock(stdout="default via 192.168.1.1 dev eth0")
        with patch("netcheck.modem_diagnostics.urlopen", side_effect=URLError("unreachable")), \
             patch("netcheck.modem_diagnostics.subprocess.run", return_value=result_stub):
            result = modem_diagnostics.check_bridge_mode()
        self.assertFalse(result["multiple_gateways"])

    def test_multiple_gateways_means_not_bridge_mode(self):
        result_stub = MagicMock(
            stdout="default via 192.168.1.1 dev eth0\ndefault via 10.0.0.1 dev eth1")
        with patch("netcheck.modem_diagnostics.urlopen", side_effect=URLError("unreachable")), \
             patch("netcheck.modem_diagnostics.subprocess.run", return_value=result_stub):
            result = modem_diagnostics.check_bridge_mode()
        self.assertTrue(result["multiple_gateways"])
        self.assertFalse(result["bridge_mode_detected"])

    def test_wan_ip_detection_returns_parsed_ip(self):
        response = MagicMock()
        response.read.return_value = b'{"ip": "203.0.113.9"}'
        with patch("netcheck.modem_diagnostics.urlopen", return_value=response):
            self.assertEqual(modem_diagnostics.detect_wan_ip(), "203.0.113.9")

    def test_wan_ip_detection_returns_none_on_failure(self):
        with patch("netcheck.modem_diagnostics.urlopen", side_effect=OSError("no route")):
            self.assertIsNone(modem_diagnostics.detect_wan_ip())

    def test_signal_level_detection_returns_dict(self):
        """Signal level detection returns diagnostic dict."""
        diag = modem_diagnostics.ModemDiagnostics()
        with patch.object(diag, "detect_modem_reachable",
                          return_value={"reachable": True, "ip": diag.modem_ip}), \
             patch("netcheck.modem_diagnostics.get_modem_status_page",
                   return_value={"raw": "", "downstream_power_dbm": 2.0}):
            result = diag.detect_signal_levels()
        self.assertTrue(result["detected"])
        self.assertEqual(result["downstream_power_dbm"], 2.0)

    def test_signal_level_detection_reports_undetected_when_modem_unreachable(self):
        diag = modem_diagnostics.ModemDiagnostics()
        with patch.object(diag, "detect_modem_reachable", return_value={"reachable": False}):
            result = diag.detect_signal_levels()
        self.assertFalse(result["detected"])

    def test_uncorrectable_codewords_detection(self):
        """Uncorrectable codeword count is parsed from the status page."""
        diag = modem_diagnostics.ModemDiagnostics()
        with patch("netcheck.modem_diagnostics.get_modem_status_page",
                   return_value={"raw": "Uncorrectable: 4"}):
            result = diag.detect_uncorrectable_codewords()
        self.assertTrue(result["detected"])
        self.assertEqual(result["uncorrectable_errors"], 4)


if __name__ == "__main__":
    unittest.main()
