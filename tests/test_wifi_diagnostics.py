"""WiFi diagnostics: band-steering, DFS, signal instability, interference.
Link state and congestion are mocked at the environ boundary -- hermetic."""
import unittest
from unittest.mock import patch
from netcheck import wifi_diagnostics


def _link(state="ok", ssid="TestNet", bssid="00:11:22:33:44:55", channel=36, rssi=-50):
    if state != "ok":
        return {"state": state, "reason": "no wireless interface"}
    return {"state": "ok", "ssid": ssid, "bssid": bssid,
            "channel": channel, "rssi_dbm": rssi}


class DFSChannelDetectionTest(unittest.TestCase):
    """is_dfs_channel covers the full 5 GHz DFS range (52-144), where radar
    detection forces the AP to jump channels and kills every connection."""

    def test_dfs_range_detected_including_boundaries(self):
        for channel in [52, 64, 100, 120, 128, 144]:
            self.assertTrue(wifi_diagnostics.is_dfs_channel(channel),
                          f"Channel {channel} should be DFS")

    def test_non_dfs_5ghz_channels_not_detected(self):
        for channel in [36, 40, 44, 48, 149, 153, 157, 165]:
            self.assertFalse(wifi_diagnostics.is_dfs_channel(channel),
                           f"Channel {channel} should not be DFS")

    def test_2_4_ghz_channels_not_dfs(self):
        for channel in [1, 6, 11]:
            self.assertFalse(wifi_diagnostics.is_dfs_channel(channel))


class BandSteeringDetectionTest(unittest.TestCase):
    def test_single_bssid_no_steering(self):
        history = [{'bssid': '00:11:22:33:44:55'}] * 3
        self.assertFalse(wifi_diagnostics.detect_band_steering(history))

    def test_multiple_bssids_detected(self):
        history = [
            {'bssid': '00:11:22:33:44:55'},
            {'bssid': '00:11:22:33:44:66'},
        ]
        self.assertTrue(wifi_diagnostics.detect_band_steering(history))

    def test_single_sample_is_never_steering(self):
        self.assertFalse(wifi_diagnostics.detect_band_steering([{'bssid': 'x'}]))

    def test_class_method_reports_bssid_change_across_real_samples(self):
        """Two sample_current_state() calls that see different BSSIDs (the AP
        moved us between bands) must come back detected=True."""
        diag = wifi_diagnostics.WiFiDiagnostics()
        with patch("netcheck.wifi_diagnostics.environ.wifi",
                   side_effect=[_link(bssid="00:11:22:33:44:55"),
                                _link(bssid="00:11:22:33:44:66")]):
            diag.sample_current_state()
            result = diag.detect_band_steering()
        self.assertTrue(result['detected'])
        self.assertEqual(result['count'], 2)

    def test_class_method_reports_not_connected(self):
        diag = wifi_diagnostics.WiFiDiagnostics()
        with patch("netcheck.wifi_diagnostics.environ.wifi",
                   return_value=_link(state="unavailable")):
            result = diag.detect_band_steering()
        self.assertFalse(result['detected'])
        self.assertEqual(result['reason'], 'Not connected to WiFi')


class SignalInstabilityDetectionTest(unittest.TestCase):
    def test_stable_signal_no_warning(self):
        history = [{'signal_dbm': s} for s in (-50, -52, -51, -50)]
        self.assertFalse(wifi_diagnostics.detect_signal_instability(history, threshold_dbm=20))

    def test_large_signal_variation_detected(self):
        history = [{'signal_dbm': s} for s in (-30, -80, -35)]
        self.assertTrue(wifi_diagnostics.detect_signal_instability(history, threshold_dbm=20))

    def test_class_method_reports_variation_details(self):
        diag = wifi_diagnostics.WiFiDiagnostics()
        diag.history = [{'signal_dbm': -30}, {'signal_dbm': -80}]
        result = diag.detect_signal_instability()
        self.assertTrue(result['unstable'])
        self.assertEqual(result['variation_dbm'], 50)
        self.assertEqual(result['min'], -80)
        self.assertEqual(result['max'], -30)


class DFSChannelWarningTest(unittest.TestCase):
    def test_dfs_channel_triggers_warning_with_radar_reason(self):
        diag = wifi_diagnostics.WiFiDiagnostics()
        with patch("netcheck.wifi_diagnostics.environ.wifi",
                   return_value=_link(channel=128)):
            result = diag.detect_dfs_channel_warning()
        self.assertTrue(result['warning'])
        self.assertEqual(result['channel'], 128)
        self.assertIn('radar', result['reason'].lower())

    def test_non_dfs_channel_no_warning(self):
        diag = wifi_diagnostics.WiFiDiagnostics()
        with patch("netcheck.wifi_diagnostics.environ.wifi",
                   return_value=_link(channel=36)):
            result = diag.detect_dfs_channel_warning()
        self.assertFalse(result['warning'])
        self.assertEqual(result['channel'], 36)


class InterferenceCongestionTest(unittest.TestCase):
    def test_congestion_true_when_more_than_three_cochannel(self):
        diag = wifi_diagnostics.WiFiDiagnostics()
        with patch("netcheck.wifi_diagnostics.environ.wifi", return_value=_link(channel=6)), \
             patch("netcheck.wifi_diagnostics.environ.congestion",
                   return_value={"state": "ok", "total_bssids": 6, "cochannel": 5, "same_block": 0}):
            result = diag.check_interference()
        self.assertTrue(result['congestion'])
        self.assertEqual(result['same_channel'], 5)

    def test_clear_channel_no_congestion(self):
        diag = wifi_diagnostics.WiFiDiagnostics()
        with patch("netcheck.wifi_diagnostics.environ.wifi", return_value=_link(channel=36)), \
             patch("netcheck.wifi_diagnostics.environ.congestion",
                   return_value={"state": "ok", "total_bssids": 2, "cochannel": 1, "same_block": 0}):
            result = diag.check_interference()
        self.assertFalse(result['congestion'])

    def test_scan_failure_reports_unknown_not_a_verdict(self):
        """A failed scan must never read as 'no congestion' -- same
        unavailable-is-not-fail rule every probe follows."""
        diag = wifi_diagnostics.WiFiDiagnostics()
        with patch("netcheck.wifi_diagnostics.environ.wifi", return_value=_link(channel=6)), \
             patch("netcheck.wifi_diagnostics.environ.congestion",
                   return_value={"state": "unavailable", "reason": "netsh unavailable"}):
            result = diag.check_interference()
        self.assertEqual(result['congestion'], 'unknown')


class SampleCurrentStateTest(unittest.TestCase):
    def test_sample_maps_environ_wifi_fields_and_appends_history(self):
        diag = wifi_diagnostics.WiFiDiagnostics()
        with patch("netcheck.wifi_diagnostics.environ.wifi",
                   return_value=_link(ssid="Home", bssid="aa:bb:cc:dd:ee:ff",
                                     channel=44, rssi=-61)):
            sample = diag.sample_current_state()
        self.assertEqual(sample['ssid'], "Home")
        self.assertEqual(sample['bssid'], "aa:bb:cc:dd:ee:ff")
        self.assertEqual(sample['channel'], 44)
        self.assertEqual(sample['signal_dbm'], -61)
        self.assertEqual(diag.history, [sample])

    def test_not_connected_returns_none_and_keeps_history_clean(self):
        diag = wifi_diagnostics.WiFiDiagnostics()
        with patch("netcheck.wifi_diagnostics.environ.wifi",
                   return_value=_link(state="fail")):
            self.assertIsNone(diag.sample_current_state())
        self.assertEqual(diag.history, [])


if __name__ == "__main__":
    unittest.main()
