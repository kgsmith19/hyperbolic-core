"""Wi-Fi link-state and neighbour-congestion parsers: pure functions over
captured command output.

Fixtures are real output captured from a live machine — so a Windows format
change breaks a test rather than silently producing null metrics — with SSID,
BSSID, MAC and GUID replaced by placeholders. A BSSID is enough to locate a
house through Wi-Fi geolocation databases, so it does not belong in a repo.
"""
import unittest

from netcheck import wlan_probes

from tests import fixture


class ParseWlanInterfacesTest(unittest.TestCase):
    def setUp(self):
        self.got = wlan_probes.parse_wlan_interfaces(fixture("wlan_interfaces.txt"))

    def test_extracts_link_fields(self):
        """Criterion 2."""
        self.assertEqual(self.got["state"], "ok")
        self.assertEqual(self.got["ssid"], "HomeNet_5G")
        self.assertEqual(self.got["bssid"], "02:00:5e:10:00:01")
        self.assertEqual(self.got["band"], "5 GHz")
        self.assertEqual(self.got["channel"], 44)
        self.assertEqual(self.got["signal_pct"], 93)
        self.assertEqual(self.got["rx_mbps"], 1560.0)
        self.assertEqual(self.got["tx_mbps"], 1733.3)
        self.assertEqual(self.got["radio"], "802.11ac")

    def test_extracts_rssi_dbm(self):
        """dBm is the real signal metric; the percentage is a vendor curve."""
        self.assertEqual(self.got["rssi_dbm"], -41)

    def test_disconnected_interface_is_not_ok(self):
        got = wlan_probes.parse_wlan_interfaces(
            "    Name                   : Wi-Fi\n"
            "    State                  : disconnected\n")
        self.assertEqual(got["state"], "fail")

    def test_no_wireless_interface_is_unavailable_not_fail(self):
        """An ethernet-only machine has not got a Wi-Fi problem."""
        got = wlan_probes.parse_wlan_interfaces(
            "There is no wireless interface on the system.")
        self.assertEqual(got["state"], "unavailable")


class ParseWlanNetworksTest(unittest.TestCase):
    def test_counts_own_channel_excluding_self(self):
        """Criterion 3: our own BSSID is not interference with itself."""
        got = wlan_probes.parse_wlan_networks(
            fixture("wlan_networks.txt"), channel=44,
            own_bssid="02:00:5e:10:00:01")
        self.assertEqual(got["total_bssids"], 1)
        self.assertEqual(got["cochannel"], 0)

    def test_own_bssid_not_found_still_counts_all_networks(self):
        """If our BSSID is not in the scan (shouldn't happen), treat it as
        no self to exclude. All networks are counted, none excluded."""
        text = ("    BSSID 1                 : aa:aa:aa:aa:aa:aa\n"
                "         Channel            : 44 \n"
                "    BSSID 2                 : bb:bb:bb:bb:bb:bb\n"
                "         Channel            : 44 \n")
        got = wlan_probes.parse_wlan_networks(text, channel=44,
                                              own_bssid="ff:ff:ff:ff:ff:ff")
        self.assertEqual(got["total_bssids"], 2)
        self.assertEqual(got["cochannel"], 2)  # Both count as co-channel

    def test_none_own_bssid_counts_all_networks(self):
        """If own_bssid is None (not provided), all networks are counted."""
        text = ("    BSSID 1                 : aa:aa:aa:aa:aa:aa\n"
                "         Channel            : 44 \n"
                "    BSSID 2                 : bb:bb:bb:bb:bb:bb\n"
                "         Channel            : 44 \n")
        got = wlan_probes.parse_wlan_networks(text, channel=44, own_bssid=None)
        self.assertEqual(got["total_bssids"], 2)
        self.assertEqual(got["cochannel"], 2)

    def test_counts_neighbours_on_the_same_channel(self):
        text = ("    BSSID 1                 : aa:aa:aa:aa:aa:aa\n"
                "         Channel            : 44 \n"
                "    BSSID 2                 : bb:bb:bb:bb:bb:bb\n"
                "         Channel            : 44 \n"
                "    BSSID 3                 : cc:cc:cc:cc:cc:cc\n"
                "         Channel            : 149 \n")
        got = wlan_probes.parse_wlan_networks(text, channel=44,
                                              own_bssid="aa:aa:aa:aa:aa:aa")
        self.assertEqual(got["total_bssids"], 3)
        self.assertEqual(got["cochannel"], 1)

    def test_counts_the_overlapping_80mhz_block(self):
        """5 GHz channels 36/40/44/48 share one 80 MHz block, so they collide
        even though none of them is literally channel 44."""
        text = ("    BSSID 1                 : aa:aa:aa:aa:aa:aa\n"
                "         Channel            : 36 \n"
                "    BSSID 2                 : bb:bb:bb:bb:bb:bb\n"
                "         Channel            : 48 \n"
                "    BSSID 3                 : cc:cc:cc:cc:cc:cc\n"
                "         Channel            : 149 \n")
        got = wlan_probes.parse_wlan_networks(text, channel=44)
        self.assertEqual(got["cochannel"], 0)
        self.assertEqual(got["same_block"], 2)

    def test_empty_scan_is_unavailable_not_a_clean_zero(self):
        """A scan that returned nothing is not proof of an empty airwave."""
        got = wlan_probes.parse_wlan_networks("", channel=44)
        self.assertEqual(got["state"], "unavailable")


class ParseAirportInfoTest(unittest.TestCase):
    """macOS `airport -I` parser. Unlike the other fixtures here, this one is
    hand-built from Apple's documented output format rather than captured
    from a live Mac. Treat this parser as needing
    real-machine verification before being trusted the way the Windows
    parsers are."""

    def test_extracts_link_fields(self):
        result = wlan_probes.parse_airport_info(fixture("airport_info.txt"))
        self.assertEqual(result["state"], "ok")
        self.assertEqual(result["ssid"], "ExampleNet")
        self.assertEqual(result["bssid"], "a1:b2:c3:d4:e5:f6")
        self.assertEqual(result["channel"], 44)
        self.assertEqual(result["band"], "5 GHz")
        self.assertEqual(result["rssi_dbm"], -52)

    def test_2ghz_channel_reports_2point4_band(self):
        result = wlan_probes.parse_airport_info("state: running\nSSID: x\nchannel: 6\n")
        self.assertEqual(result["band"], "2.4 GHz")

    def test_not_associated_is_fail_not_unavailable(self):
        """Radio is on and working, just not joined to a network -- a real
        (if uninteresting) measurement, not a missing one."""
        result = wlan_probes.parse_airport_info("state: init\n")
        self.assertEqual(result["state"], "fail")

    def test_wifi_off_is_unavailable(self):
        result = wlan_probes.parse_airport_info("     AirPort: Off\n")
        self.assertEqual(result["state"], "unavailable")

    def test_empty_output_is_unavailable(self):
        result = wlan_probes.parse_airport_info("")
        self.assertEqual(result["state"], "unavailable")


if __name__ == "__main__":
    unittest.main()
