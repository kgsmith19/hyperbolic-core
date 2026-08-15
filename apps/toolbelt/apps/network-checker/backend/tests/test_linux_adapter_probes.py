"""Linux `iw`/`ethtool` adapter-state probes (netcheck/linux_adapter_probes.py;
05-f section 4.5's Finding 18): pure parsers over hand-built command text --
this sandbox has neither `iw` nor `ethtool` nor a real wireless adapter to
capture fixtures from, so the text below is built to match `iw`'s and
`ethtool`'s well-documented, stable output grammar rather than a live
capture, the same honesty tests/fixtures/airport_info.txt's own comment
flags for its own not-yet-verified-against-a-live-capture fixture -- plus
the IO functions with `_run`/`os.listdir` mocked at the seam, exactly
tests/test_environ.py's `WifiPlatformDispatchTest` convention.
"""
import unittest
from unittest.mock import patch

from netcheck import linux_adapter_probes as lap

IW_DEV_INFO_5GHZ = (
    "Interface wlan0\n"
    "\tifindex 3\n"
    "\taddr aa:bb:cc:dd:ee:ff\n"
    "\tssid HomeNet\n"
    "\ttype managed\n"
    "\twiphy 0\n"
    "\tchannel 36 (5180 MHz), width: 80 MHz, center1: 5210 MHz\n"
    "\ttxpower {} dBm\n"
)

IW_PHY_INFO_5GHZ = (
    "Wiphy phy0\n"
    "\tBand 1:\n"
    "\t\tFrequencies:\n"
    "\t\t\t* 2412 MHz [1] (20.0 dBm)\n"
    "\tBand 2:\n"
    "\t\tFrequencies:\n"
    "\t\t\t* 5180 MHz [36] (23.0 dBm)\n"
    "\t\t\t* 5200 MHz [40] (23.0 dBm)\n"
)


class ParseIwLinkTest(unittest.TestCase):
    def test_extracts_frequency_and_live_txpower(self):
        got = lap.parse_iw_link(IW_DEV_INFO_5GHZ.format("23.00"))
        self.assertEqual(got["state"], "ok")
        self.assertEqual(got["freq_mhz"], 5180)
        self.assertEqual(got["txpower_dbm"], 23.0)

    def test_pinned_low_txpower_still_parses_as_ok(self):
        """Parsing succeeds regardless of the number -- discrimination is
        wifi_txpower()'s job, not the parser's."""
        got = lap.parse_iw_link(IW_DEV_INFO_5GHZ.format("1.00"))
        self.assertEqual(got["state"], "ok")
        self.assertEqual(got["txpower_dbm"], 1.0)

    def test_no_txpower_line_is_unavailable(self):
        """A failed/wrong-interface query has no txpower line at all --
        must not be misread as a healthy zero."""
        got = lap.parse_iw_link("command failed: No such device\n")
        self.assertEqual(got["state"], "unavailable")
        self.assertIsNone(got["txpower_dbm"])


class ParseIwPhyCeilingTest(unittest.TestCase):
    def test_finds_the_ceiling_for_the_current_channel(self):
        self.assertEqual(lap.parse_iw_phy_ceiling(IW_PHY_INFO_5GHZ, 5180), 23.0)

    def test_unmatched_frequency_is_none(self):
        self.assertIsNone(lap.parse_iw_phy_ceiling(IW_PHY_INFO_5GHZ, 5745))

    def test_no_frequency_to_look_up_is_none(self):
        self.assertIsNone(lap.parse_iw_phy_ceiling(IW_PHY_INFO_5GHZ, None))


class ParseIwPowerSaveTest(unittest.TestCase):
    def test_on(self):
        self.assertIs(lap.parse_iw_power_save("Power save: on\n"), True)

    def test_off(self):
        self.assertIs(lap.parse_iw_power_save("Power save: off\n"), False)

    def test_unparseable_is_none(self):
        self.assertIsNone(lap.parse_iw_power_save("command failed\n"))


class ParseEthtoolWolTest(unittest.TestCase):
    def test_magic_packet_flag_is_armed(self):
        self.assertIs(lap.parse_ethtool_wol("\tWake-on: g\n"), True)

    def test_d_alone_is_disabled(self):
        self.assertIs(lap.parse_ethtool_wol("\tWake-on: d\n"), False)

    def test_missing_line_is_none(self):
        self.assertIsNone(lap.parse_ethtool_wol("Settings for wlan0:\n"))


class FindAdapterTest(unittest.TestCase):
    def test_matches_primary_pattern_first(self):
        with patch("netcheck.linux_adapter_probes.os.listdir",
                   return_value=["lo", "eth0", "wlan0"]):
            self.assertEqual(lap.find_adapter(r"wlan|wifi", r"eth|eno|enp"), "wlan0")

    def test_falls_back_when_primary_pattern_absent(self):
        with patch("netcheck.linux_adapter_probes.os.listdir",
                   return_value=["lo", "eth0"]):
            self.assertEqual(lap.find_adapter(r"wlan|wifi", r"eth|eno|enp"), "eth0")

    def test_no_match_anywhere_is_none(self):
        with patch("netcheck.linux_adapter_probes.os.listdir", return_value=["lo"]):
            self.assertIsNone(lap.find_adapter(r"wlan|wifi", r"eth|eno|enp"))

    def test_unreadable_sysfs_is_none_not_a_raise(self):
        with patch("netcheck.linux_adapter_probes.os.listdir", side_effect=OSError):
            self.assertIsNone(lap.find_adapter(r"wlan|wifi"))


class WifiTxpowerDiscriminationTest(unittest.TestCase):
    """The property-specific verify probe the wifi_mode template now uses
    in place of a bare gw:ok (Finding 18): it must tell a fixed-at-ceiling
    ('auto' took) radio apart from one still pinned below it."""

    def _run(self, adapter=None):
        return lap.wifi_txpower(adapter="wlan0")

    def test_at_ceiling_is_ok(self):
        """State DOES match expected: live txpower equals this channel's
        own regulatory ceiling."""
        with patch("netcheck.linux_adapter_probes.LINUX", True), \
             patch("netcheck.linux_adapter_probes._run") as mock_run:
            mock_run.side_effect = [
                (IW_DEV_INFO_5GHZ.format("23.00"), "ok"),
                (IW_PHY_INFO_5GHZ, "ok"),
            ]
            got = self._run()
        self.assertEqual(got["state"], "ok")
        self.assertEqual(got["txpower_dbm"], 23.0)
        self.assertEqual(got["ceiling_dbm"], 23.0)

    def test_pinned_below_ceiling_is_fail(self):
        """State does NOT match expected: the exact wifi_mode_pinned fault
        this template exists to fix."""
        with patch("netcheck.linux_adapter_probes.LINUX", True), \
             patch("netcheck.linux_adapter_probes._run") as mock_run:
            mock_run.side_effect = [
                (IW_DEV_INFO_5GHZ.format("1.00"), "ok"),
                (IW_PHY_INFO_5GHZ, "ok"),
            ]
            got = self._run()
        self.assertEqual(got["state"], "fail")
        self.assertEqual(got["txpower_dbm"], 1.0)

    def test_no_adapter_is_unavailable_not_fail(self):
        with patch("netcheck.linux_adapter_probes.LINUX", True), \
             patch("netcheck.linux_adapter_probes.find_adapter", return_value=None):
            got = lap.wifi_txpower()
        self.assertEqual(got["state"], "unavailable")

    def test_non_linux_is_unavailable_even_with_an_adapter_name(self):
        with patch("netcheck.linux_adapter_probes.LINUX", False):
            got = self._run()
        self.assertEqual(got["state"], "unavailable")

    def test_unmatched_channel_ceiling_is_unavailable_not_a_guess(self):
        """A channel this phy's info text does not list at all -- must not
        be scored fail/ok against a fabricated ceiling."""
        with patch("netcheck.linux_adapter_probes.LINUX", True), \
             patch("netcheck.linux_adapter_probes._run") as mock_run:
            mock_run.side_effect = [
                (IW_DEV_INFO_5GHZ.format("20.00").replace("5180", "5745"), "ok"),
                (IW_PHY_INFO_5GHZ, "ok"),
            ]
            got = self._run()
        self.assertEqual(got["state"], "unavailable")


class AdapterPowerDiscriminationTest(unittest.TestCase):
    """The property-specific verify probe the adapter_power template now
    uses in place of a bare gw:ok: power_save off and WoL armed together,
    the exact pair fix_adapter_power.sh's disable_power_management sets."""

    def test_optimal_state_is_ok(self):
        """State DOES match expected."""
        with patch("netcheck.linux_adapter_probes.LINUX", True), \
             patch("netcheck.linux_adapter_probes._run") as mock_run:
            mock_run.side_effect = [
                ("Power save: off\n", "ok"),
                ("Settings for wlan0:\n\tWake-on: g\n", "ok"),
            ]
            got = lap.adapter_power(adapter="wlan0")
        self.assertEqual(got["state"], "ok")
        self.assertIs(got["power_save"], False)
        self.assertIs(got["wol"], True)

    def test_power_save_still_on_is_fail(self):
        """State does NOT match expected: power management never got
        disabled, even though WoL happens to be armed."""
        with patch("netcheck.linux_adapter_probes.LINUX", True), \
             patch("netcheck.linux_adapter_probes._run") as mock_run:
            mock_run.side_effect = [
                ("Power save: on\n", "ok"),
                ("Settings for wlan0:\n\tWake-on: g\n", "ok"),
            ]
            got = lap.adapter_power(adapter="wlan0")
        self.assertEqual(got["state"], "fail")

    def test_wol_still_disabled_is_fail(self):
        """State does NOT match expected: the other half of the pair."""
        with patch("netcheck.linux_adapter_probes.LINUX", True), \
             patch("netcheck.linux_adapter_probes._run") as mock_run:
            mock_run.side_effect = [
                ("Power save: off\n", "ok"),
                ("Settings for wlan0:\n\tWake-on: d\n", "ok"),
            ]
            got = lap.adapter_power(adapter="wlan0")
        self.assertEqual(got["state"], "fail")

    def test_no_adapter_at_all_is_unavailable(self):
        with patch("netcheck.linux_adapter_probes.LINUX", True), \
             patch("netcheck.linux_adapter_probes.find_adapter", return_value=None):
            got = lap.adapter_power()
        self.assertEqual(got["state"], "unavailable")

    def test_ethtool_missing_is_unavailable_not_fail(self):
        with patch("netcheck.linux_adapter_probes.LINUX", True), \
             patch("netcheck.linux_adapter_probes._run") as mock_run:
            mock_run.side_effect = [
                ("Power save: off\n", "ok"),
                ("", "unavailable"),
            ]
            got = lap.adapter_power(adapter="wlan0")
        self.assertEqual(got["state"], "unavailable")


if __name__ == "__main__":
    unittest.main()
