import unittest
from netcheck import router_diagnostics

class RouterDiagnosticsTest(unittest.TestCase):
    def test_firmware_currency_check(self):
        diag = router_diagnostics.RouterDiagnostics()
        result = diag.check_firmware_currency()
        self.assertIsInstance(result, dict)
        self.assertIn('recommendation', result)

    def test_qos_settings_check(self):
        diag = router_diagnostics.RouterDiagnostics()
        result = diag.check_qos_settings()
        self.assertIsInstance(result, dict)
        self.assertIn('features_to_check', result)

    def test_security_features_check(self):
        diag = router_diagnostics.RouterDiagnostics()
        result = diag.check_security_features()
        self.assertIsInstance(result, dict)
        self.assertIn('features_to_check', result)

    def test_bridge_mode_recommendation(self):
        diag = router_diagnostics.RouterDiagnostics()
        result = diag.check_bridge_mode_setting()
        self.assertIsInstance(result, dict)

    def test_band_steering_recommendation(self):
        diag = router_diagnostics.RouterDiagnostics()
        result = diag.check_band_steering()
        self.assertIsInstance(result, dict)

    def test_recommended_settings(self):
        diag = router_diagnostics.RouterDiagnostics()
        result = diag.get_recommended_settings()
        self.assertIsInstance(result, dict)
        self.assertIn('settings', result)

if __name__ == "__main__":
    unittest.main()
