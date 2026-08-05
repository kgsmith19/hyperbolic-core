"""Parsers are pure functions over captured command output.

Fixtures are real output captured from a live machine — so a Windows format
change breaks a test rather than silently producing null metrics — with SSID,
BSSID, MAC and GUID replaced by placeholders. A BSSID is enough to locate a
house through Wi-Fi geolocation databases, so it does not belong in a repo.
"""
import unittest
from pathlib import Path

from netcheck import probes

FIXTURES = Path(__file__).parent / "fixtures"


def fixture(name):
    # utf-8-sig: the captured files carry a BOM that live command output does not.
    return (FIXTURES / name).read_text(encoding="utf-8-sig")


class ParsePingTest(unittest.TestCase):
    def test_windows_reply(self):
        """Criterion 1: Windows ping output yields loss and rtt."""
        got = probes.parse_ping(fixture("ping_win.txt"))
        self.assertEqual(got["state"], "ok")
        self.assertEqual(got["loss_pct"], 0.0)
        self.assertEqual(got["rtt_avg_ms"], 14.0)
        self.assertEqual(got["rtt_min_ms"], 12.0)
        self.assertEqual(got["rtt_max_ms"], 16.0)

    def test_unix_reply(self):
        """Criterion 1: the same function handles BSD/Linux output."""
        got = probes.parse_ping(
            "2 packets transmitted, 2 packets received, 0.0% packet loss\n"
            "round-trip min/avg/max/stddev = 13.5/14.0/14.7/0.4 ms\n")
        self.assertEqual(got["state"], "ok")
        self.assertEqual(got["loss_pct"], 0.0)
        self.assertEqual(got["rtt_avg_ms"], 14.0)

    def test_partial_loss_is_still_ok_with_loss_recorded(self):
        """Degraded is not down. Loss is the signal; 'ok' means we measured."""
        got = probes.parse_ping(
            "4 packets transmitted, 3 packets received, 25.0% packet loss\n"
            "round-trip min/avg/max/stddev = 10.0/20.0/30.0/1.0 ms\n")
        self.assertEqual(got["state"], "ok")
        self.assertEqual(got["loss_pct"], 25.0)

    def test_total_loss_is_fail(self):
        got = probes.parse_ping(
            "4 packets transmitted, 0 packets received, 100.0% packet loss\n")
        self.assertEqual(got["state"], "fail")
        self.assertEqual(got["loss_pct"], 100.0)

    def test_unreachable_is_fail_not_a_silent_zero(self):
        """Unparseable output must never read as a healthy 0ms."""
        got = probes.parse_ping("Destination host unreachable.")
        self.assertEqual(got["state"], "fail")
        self.assertIsNone(got["rtt_avg_ms"])


class ParseWlanInterfacesTest(unittest.TestCase):
    def setUp(self):
        self.got = probes.parse_wlan_interfaces(fixture("wlan_interfaces.txt"))

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
        got = probes.parse_wlan_interfaces(
            "    Name                   : Wi-Fi\n"
            "    State                  : disconnected\n")
        self.assertEqual(got["state"], "fail")

    def test_no_wireless_interface_is_unavailable_not_fail(self):
        """An ethernet-only machine has not got a Wi-Fi problem."""
        got = probes.parse_wlan_interfaces(
            "There is no wireless interface on the system.")
        self.assertEqual(got["state"], "unavailable")


class ParseWlanNetworksTest(unittest.TestCase):
    def test_counts_own_channel_excluding_self(self):
        """Criterion 3: our own BSSID is not interference with itself."""
        got = probes.parse_wlan_networks(
            fixture("wlan_networks.txt"), channel=44,
            own_bssid="02:00:5e:10:00:01")
        self.assertEqual(got["total_bssids"], 1)
        self.assertEqual(got["cochannel"], 0)

    def test_counts_neighbours_on_the_same_channel(self):
        text = ("    BSSID 1                 : aa:aa:aa:aa:aa:aa\n"
                "         Channel            : 44 \n"
                "    BSSID 2                 : bb:bb:bb:bb:bb:bb\n"
                "         Channel            : 44 \n"
                "    BSSID 3                 : cc:cc:cc:cc:cc:cc\n"
                "         Channel            : 149 \n")
        got = probes.parse_wlan_networks(text, channel=44,
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
        got = probes.parse_wlan_networks(text, channel=44)
        self.assertEqual(got["cochannel"], 0)
        self.assertEqual(got["same_block"], 2)

    def test_empty_scan_is_unavailable_not_a_clean_zero(self):
        """A scan that returned nothing is not proof of an empty airwave."""
        got = probes.parse_wlan_networks("", channel=44)
        self.assertEqual(got["state"], "unavailable")


class ParseTracerouteTest(unittest.TestCase):
    """Real output from this machine: the ISP's edge is on RFC1918 space, and
    hop 2 does not answer at all."""

    RAW = ("\nTracing route to 1.1.1.1 over a maximum of 4 hops\n\n"
           "  1     3 ms     1 ms     1 ms  192.168.50.1 \n"
           "  2     *        *        *     Request timed out.\n"
           "  3    11 ms    11 ms    12 ms  172.16.1.118 \n"
           "  4    13 ms    17 ms    17 ms  172.16.7.3 \n\nTrace complete.\n")

    def test_returns_first_responding_hop_past_the_gateway(self):
        self.assertEqual(
            probes.parse_traceroute(self.RAW, "192.168.50.1", "1.1.1.1"),
            "172.16.1.118")

    def test_skips_non_responding_hops(self):
        """Hop 2 timed out; picking it would give an unpingable target."""
        self.assertNotIn(
            probes.parse_traceroute(self.RAW, "192.168.50.1", "1.1.1.1"),
            (None, "192.168.50.1"))

    def test_does_not_return_the_target_itself(self):
        raw = ("  1     3 ms  192.168.50.1 \n"
               "  2    13 ms  1.1.1.1 \n")
        self.assertIsNone(probes.parse_traceroute(raw, "192.168.50.1", "1.1.1.1"))

    def test_no_hops_at_all_is_none(self):
        self.assertIsNone(probes.parse_traceroute("Trace complete.\n",
                                                  "192.168.50.1", "1.1.1.1"))


class _PlainCtx:
    """Stands in for an SSLContext, handing back the raw socket.

    The hold/detect loop is ours and is where bugs live; TLS wrapping is
    stdlib's. Testing through a real handshake would mean shipping a private
    key in the repo to prove something OpenSSL already guarantees.
    """
    @staticmethod
    def wrap_socket(sock, server_hostname=None):
        return sock


class IdleHoldTest(unittest.TestCase):
    """Criterion 12: distinguish a connection that was reaped from one that held."""

    def _server(self, close_immediately):
        import socket as s, threading
        srv = s.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)

        held = []

        def serve():
            conn, _ = srv.accept()
            if close_immediately:
                conn.close()
            else:
                held.append(conn)           # keep the peer alive for the test
        threading.Thread(target=serve, daemon=True).start()
        self.addCleanup(lambda: [c.close() for c in held])
        self.addCleanup(srv.close)
        return srv.getsockname()

    def test_peer_closing_is_reported_as_closed_by_peer(self):
        host, port = self._server(close_immediately=True)
        got = probes.idle_hold(host, port, seconds=0.5, ctx=_PlainCtx)
        self.assertEqual(got["result"], "closed_by_peer")
        self.assertEqual(got["state"], "fail")

    def test_surviving_the_window_is_reported_as_still_alive(self):
        host, port = self._server(close_immediately=False)
        got = probes.idle_hold(host, port, seconds=0.5, ctx=_PlainCtx)
        self.assertEqual(got["result"], "still_alive")
        self.assertEqual(got["state"], "ok")

    def test_unreachable_port_is_connect_error_not_a_false_drop(self):
        """Failing to connect is not the same finding as being disconnected."""
        got = probes.idle_hold("127.0.0.1", 1, seconds=0.5, ctx=_PlainCtx)
        self.assertEqual(got["result"], "connect_error")


if __name__ == "__main__":
    unittest.main()
