"""Interference diagnostics tests: real co-channel/same-block detection via
environ.wifi()/environ.congestion(), mocked at that boundary -- hermetic."""
import unittest
from unittest.mock import patch
from netcheck import interference_diagnostics


def _wifi(state="ok", channel=36, bssid="aa:bb:cc:dd:ee:ff", rssi=-50, reason=None):
    if state != "ok":
        return {"state": state, "reason": reason or "not connected"}
    return {"state": "ok", "channel": channel, "bssid": bssid, "rssi_dbm": rssi}


class InterferenceScanTest(unittest.TestCase):
    def test_detected_when_cochannel_networks_present(self):
        with patch("netcheck.interference_diagnostics.environ.wifi", return_value=_wifi()), \
             patch("netcheck.interference_diagnostics.environ.congestion",
                   return_value={"state": "ok", "total_bssids": 5, "cochannel": 2, "same_block": 1}):
            result = interference_diagnostics.InterferenceDiagnostics().scan_interference_sources()
        self.assertTrue(result["detected"])
        self.assertEqual(result["cochannel_count"], 2)
        self.assertEqual(result["same_block_count"], 1)

    def test_not_detected_when_channel_clear(self):
        with patch("netcheck.interference_diagnostics.environ.wifi", return_value=_wifi()), \
             patch("netcheck.interference_diagnostics.environ.congestion",
                   return_value={"state": "ok", "total_bssids": 1, "cochannel": 0, "same_block": 0}):
            result = interference_diagnostics.InterferenceDiagnostics().scan_interference_sources()
        self.assertFalse(result["detected"])

    def test_reports_reason_instead_of_crashing_when_not_connected(self):
        with patch("netcheck.interference_diagnostics.environ.wifi",
                   return_value=_wifi(state="fail", reason="no wireless interface")):
            result = interference_diagnostics.InterferenceDiagnostics().scan_interference_sources()
        self.assertFalse(result["detected"])
        self.assertEqual(result["reason"], "no wireless interface")


class ChannelOverlapTest(unittest.TestCase):
    def test_overlap_true_when_same_block_congested(self):
        with patch("netcheck.interference_diagnostics.environ.wifi", return_value=_wifi()), \
             patch("netcheck.interference_diagnostics.environ.congestion",
                   return_value={"state": "ok", "total_bssids": 3, "cochannel": 0, "same_block": 2}):
            result = interference_diagnostics.InterferenceDiagnostics().detect_channel_overlap()
        self.assertTrue(result["overlap_detected"])

    def test_overlap_false_when_block_clear(self):
        with patch("netcheck.interference_diagnostics.environ.wifi", return_value=_wifi()), \
             patch("netcheck.interference_diagnostics.environ.congestion",
                   return_value={"state": "ok", "total_bssids": 1, "cochannel": 0, "same_block": 0}):
            result = interference_diagnostics.InterferenceDiagnostics().detect_channel_overlap()
        self.assertFalse(result["overlap_detected"])


class SignalQualityTest(unittest.TestCase):
    def test_good_at_strong_rssi(self):
        with patch("netcheck.interference_diagnostics.environ.wifi", return_value=_wifi(rssi=-40)):
            result = interference_diagnostics.InterferenceDiagnostics().check_signal_quality()
        self.assertEqual(result["quality"], "good")

    def test_fair_between_thresholds(self):
        with patch("netcheck.interference_diagnostics.environ.wifi", return_value=_wifi(rssi=-60)):
            result = interference_diagnostics.InterferenceDiagnostics().check_signal_quality()
        self.assertEqual(result["quality"], "fair")

    def test_poor_at_weak_rssi(self):
        with patch("netcheck.interference_diagnostics.environ.wifi", return_value=_wifi(rssi=-80)):
            result = interference_diagnostics.InterferenceDiagnostics().check_signal_quality()
        self.assertEqual(result["quality"], "poor")

    def test_unknown_when_not_connected(self):
        with patch("netcheck.interference_diagnostics.environ.wifi",
                   return_value=_wifi(state="unavailable")):
            result = interference_diagnostics.InterferenceDiagnostics().check_signal_quality()
        self.assertEqual(result["quality"], "unknown")


if __name__ == "__main__":
    unittest.main()
