"""Finding the gateway and the ISP's first hop.

Both parsers are pure functions over captured command output, so the whole
route-discovery path is testable without a network -- which matters most for
the case that produced the bug they exist for: a machine whose gateway
changed mid-run.
"""
import unittest

from network_checker import route

from tests import fixture


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
            route.parse_traceroute(self.RAW, "192.168.50.1", "1.1.1.1"),
            "172.16.1.118")

    def test_skips_non_responding_hops(self):
        """Hop 2 timed out; picking it would give an unpingable target."""
        self.assertNotIn(
            route.parse_traceroute(self.RAW, "192.168.50.1", "1.1.1.1"),
            (None, "192.168.50.1"))

    def test_does_not_return_the_target_itself(self):
        raw = ("  1     3 ms  192.168.50.1 \n"
               "  2    13 ms  1.1.1.1 \n")
        self.assertIsNone(route.parse_traceroute(raw, "192.168.50.1", "1.1.1.1"))

    def test_no_hops_at_all_is_none(self):
        self.assertIsNone(route.parse_traceroute("Trace complete.\n",
                                                  "192.168.50.1", "1.1.1.1"))

    def test_target_as_first_hop_is_none(self):
        """If the target IS the first responding hop, there's no hop past it."""
        raw = ("  1    13 ms  1.1.1.1 \n")
        self.assertIsNone(route.parse_traceroute(raw, "192.168.50.1", "1.1.1.1"))

    def test_gateway_as_first_hop_still_skips_it(self):
        """Gateway is by definition hop 1. If it's in the output, skip it."""
        raw = ("  1     3 ms  192.168.50.1 \n"
               "  2    13 ms  172.16.1.1 \n")
        self.assertEqual(
            route.parse_traceroute(raw, "192.168.50.1", "1.1.1.1"), "172.16.1.1")


class ParseIpconfigGatewayTest(unittest.TestCase):
    """route.gateway() reads this on every `network-checker watch` tick to know
    which IP to ping as "the router" -- getting it wrong silently makes a
    real network change (DHCP renewal, AP roam) look like a LAN outage for
    the rest of the run."""

    def test_dual_stack_adapter_picks_the_ipv4_continuation_line(self):
        """The real bug: a dual-stack Wi-Fi adapter prints its IPv6 gateway
        on the labeled line and the IPv4 one on an unlabeled line below it.
        A regex anchored right after the colon never reaches that second
        line -- it must search the whole gateway block, not just the first
        line of it."""
        text = fixture("ipconfig_dual_stack_gateway.txt")
        self.assertEqual(route.parse_ipconfig_gateway(text), "10.215.141.84")

    def test_an_earlier_adapter_with_a_blank_gateway_is_skipped(self):
        """The fixture's Tailscale adapter prints a "Default Gateway" label
        with no value at all, before the real Wi-Fi one -- the first
        occurrence must not shadow a real one that comes later."""
        text = fixture("ipconfig_dual_stack_gateway.txt")
        self.assertNotEqual(route.parse_ipconfig_gateway(text), None)

    def test_simple_single_line_gateway_still_works(self):
        """Most machines have exactly one gateway line, IPv4 only -- the
        common case must keep working unchanged."""
        text = ("Wireless LAN adapter Wi-Fi:\n\n"
                "   Default Gateway . . . . . . . . . : 192.168.1.1\n")
        self.assertEqual(route.parse_ipconfig_gateway(text), "192.168.1.1")

    def test_no_gateway_anywhere_is_none(self):
        text = ("Ethernet adapter Ethernet:\n\n"
                "   Media State . . . . . . . . . . . : Media disconnected\n")
        self.assertIsNone(route.parse_ipconfig_gateway(text))


if __name__ == "__main__":
    unittest.main()
