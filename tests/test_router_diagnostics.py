"""Router diagnostics tests: firmware, settings, security features.
The reachability ping is mocked -- hermetic, and independent of whether a
router happens to be reachable on the machine running the suite."""
import os
import unittest
from unittest.mock import patch, MagicMock
from netcheck import router_diagnostics


def _reachable(ok):
    return patch("netcheck.router_diagnostics.check_router_reachability",
                 return_value={"reachable": ok})


class RouterHostFromEnvTest(unittest.TestCase):
    """#33: the admin URL must follow ROUTER_HOST, never a hardcoded IP --
    the original bug was silently pinging 192.168.1.1 regardless of the
    real router's address."""

    def test_uses_router_host_env_var_when_set(self):
        with patch.dict(os.environ, {"ROUTER_HOST": "10.9.9.9"}):
            self.assertEqual(router_diagnostics.get_router_host(), "10.9.9.9")
            self.assertEqual(router_diagnostics.get_router_admin_url(), "http://10.9.9.9")

    def test_falls_back_to_environ_module_default_when_unset(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(router_diagnostics.get_router_host(),
                             router_diagnostics.ROUTER_HOST_DEFAULT)


class RouterDiagnosticsTest(unittest.TestCase):
    def test_firmware_currency_check_when_reachable(self):
        with _reachable(True):
            result = router_diagnostics.RouterDiagnostics().check_firmware_currency()
        self.assertTrue(result["accessible"])
        self.assertIn("recommendation", result)

    def test_firmware_currency_check_when_unreachable(self):
        with _reachable(False):
            result = router_diagnostics.RouterDiagnostics().check_firmware_currency()
        self.assertFalse(result["accessible"])

    def test_qos_settings_check(self):
        with _reachable(True):
            result = router_diagnostics.RouterDiagnostics().check_qos_settings()
        self.assertTrue(result["accessible"])
        self.assertIn("features_to_check", result)

    def test_security_features_check(self):
        with _reachable(True):
            result = router_diagnostics.RouterDiagnostics().check_security_features()
        self.assertIn("features_to_check", result)

    def test_bridge_mode_recommendation(self):
        result = router_diagnostics.RouterDiagnostics().check_bridge_mode_setting()
        self.assertIsInstance(result, dict)

    def test_band_steering_recommendation(self):
        result = router_diagnostics.RouterDiagnostics().check_band_steering()
        self.assertIsInstance(result, dict)

    def test_recommended_settings(self):
        result = router_diagnostics.RouterDiagnostics().get_recommended_settings()
        self.assertIn("settings", result)


class RouterReachabilityTest(unittest.TestCase):
    """check_router_reachability itself, with the ping subprocess mocked."""

    def test_reachable_when_ping_succeeds(self):
        with patch("netcheck.router_diagnostics.subprocess.run",
                   return_value=MagicMock(returncode=0)):
            result = router_diagnostics.check_router_reachability()
        self.assertTrue(result["reachable"])

    def test_unreachable_when_ping_fails(self):
        with patch("netcheck.router_diagnostics.subprocess.run",
                   return_value=MagicMock(returncode=1)):
            result = router_diagnostics.check_router_reachability()
        self.assertFalse(result["reachable"])

    def test_unreachable_when_ping_binary_missing(self):
        with patch("netcheck.router_diagnostics.subprocess.run",
                   side_effect=FileNotFoundError()):
            result = router_diagnostics.check_router_reachability()
        self.assertFalse(result["reachable"])


if __name__ == "__main__":
    unittest.main()
