"""Local-network device map: the pure address-resolution-table parser, and
map_devices() which composes it with ssdp.identify_gateway() to attach a
name to whichever mapped IP matches the SSDP-identified gateway. Tested
against a captured arp -a fixture the same way ssdp.py's own parser is.

FR-017's map is the address-resolution table itself -- every device that has
recently talked on the LAN already has a row in it. SSDP does not add rows;
it only names the one row (if any) matching identify_gateway()'s own
discovered device.
"""
import unittest
from unittest.mock import patch

from netcheck import ssdp, topology

from tests import fixture


class ParseNeighborTableTest(unittest.TestCase):
    """parse_neighbor_table() is a pure function over captured command text,
    handling both Windows/macOS arp -a hyphenated MACs and Linux ip neigh
    colon-separated ones with the same regex-based line scan."""

    def test_five_devices_are_extracted_with_their_macs(self):
        devices = topology.parse_neighbor_table(fixture("arp_windows.txt"))
        self.assertEqual(len(devices), 5)
        # Finding 63: stored in canonical (lowercase, colon-separated) form,
        # not verbatim off the wire -- arp_windows.txt's own text is
        # hyphenated ("aa-bb-cc-dd-ee-ff").
        self.assertIn({"ip": "192.168.1.1", "mac": "aa:bb:cc:dd:ee:ff"}, devices)
        self.assertIn({"ip": "192.168.1.40", "mac": "44:55:66:77:88:99"}, devices)

    def test_a_hyphenated_mac_is_normalized_to_colon_separated_lowercase(self):
        """Finding 63 (independent security review): normalization happens
        at the point the row is built, not only at the (now-removed) ad hoc
        broadcast-address comparison -- proven directly against a mixed-case
        hyphenated input, not just arp_windows.txt's already-lowercase one."""
        text = "192.168.1.77           AA-BB-CC-11-22-33     dynamic\n"
        self.assertEqual(topology.parse_neighbor_table(text),
                         [{"ip": "192.168.1.77", "mac": "aa:bb:cc:11:22:33"}])

    def test_broadcast_and_multicast_rows_are_not_devices(self):
        ips = [d["ip"] for d in topology.parse_neighbor_table(fixture("arp_windows.txt"))]
        self.assertNotIn("192.168.1.255", ips)
        self.assertNotIn("224.0.0.22", ips)
        self.assertNotIn("255.255.255.255", ips)

    def test_the_windows_interface_banner_is_not_a_device(self):
        """'Interface: 192.168.1.50 --- 0xb' contains an IP but names this
        host's own adapter, not a device on the LAN."""
        self.assertEqual(topology.parse_neighbor_table("Interface: 192.168.1.50 --- 0xb\n"), [])

    def test_a_linux_entry_with_no_mac_still_appears(self):
        """ip neigh's FAILED rows carry no lladdr -- the device must still
        appear, with mac=None, never dropped."""
        text = "192.168.1.99 dev eth0  FAILED\n"
        self.assertEqual(topology.parse_neighbor_table(text), [{"ip": "192.168.1.99", "mac": None}])

    def test_a_linux_entry_with_a_colon_mac_is_parsed(self):
        text = "192.168.1.5 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE\n"
        self.assertEqual(topology.parse_neighbor_table(text),
                         [{"ip": "192.168.1.5", "mac": "aa:bb:cc:dd:ee:ff"}])


class MapDevicesTest(unittest.TestCase):
    """map_devices() composes the neighbor-table wrapper with
    ssdp.identify_gateway(): 5 mapped devices in, 5 out, with only the one
    matching the SSDP-identified gateway's IP carrying a name."""

    def test_five_devices_map_one_carries_the_ssdp_name(self):
        with patch.object(topology.probes, "_run",
                          return_value=(fixture("arp_windows.txt"), "ok")), \
             patch.object(ssdp, "identify_gateway",
                          return_value={"state": "ok", "manufacturer": "ASUSTeK Computer Inc.",
                                        "model": "RT-AX88U", "ip": "192.168.1.1"}):
            got = topology.map_devices()

        self.assertEqual(got["state"], "ok")
        self.assertEqual(len(got["devices"]), 5)
        named = [d for d in got["devices"] if d["name"]]
        self.assertEqual(len(named), 1)
        self.assertEqual(named[0]["ip"], "192.168.1.1")
        self.assertEqual(named[0]["name"], "ASUSTeK Computer Inc. RT-AX88U")

    def test_a_device_with_no_ssdp_match_still_appears_unnamed(self):
        """The whole point of FR-017: a device the table lists but SSDP
        cannot name must not be dropped from the map."""
        with patch.object(topology.probes, "_run",
                          return_value=(fixture("arp_windows.txt"), "ok")), \
             patch.object(ssdp, "identify_gateway",
                          return_value={"state": "unavailable", "reason": "no SSDP response"}):
            got = topology.map_devices()

        self.assertEqual(got["state"], "ok")
        self.assertEqual(len(got["devices"]), 5)
        self.assertTrue(all(d["name"] is None for d in got["devices"]))

    def test_neighbor_command_unavailable_is_unavailable_not_fail(self):
        with patch.object(topology.probes, "_run", return_value=("", "unavailable")):
            got = topology.map_devices()
        self.assertEqual(got["state"], "unavailable")
        self.assertIn("reason", got)

    def test_neighbor_command_timeout_is_still_unavailable_not_fail(self):
        """A table we could not fetch in time is a measurement failure, not
        evidence the LAN itself is broken -- collapsed to `unavailable`
        exactly like a missing binary, never `fail`."""
        with patch.object(topology.probes, "_run", return_value=("", "fail")):
            got = topology.map_devices()
        self.assertEqual(got["state"], "unavailable")


class NeighborTableCommandTest(unittest.TestCase):
    """Windows and macOS use arp -a; Linux (neither) uses ip neigh -- the
    same probes.WINDOWS/probes.MACOS platform-branch pattern environ.py
    uses throughout."""

    def test_windows_uses_arp(self):
        with patch.object(topology, "WINDOWS", True), patch.object(topology, "MACOS", False):
            self.assertEqual(topology._neighbor_table_command(), ["arp", "-a"])

    def test_macos_uses_arp(self):
        with patch.object(topology, "WINDOWS", False), patch.object(topology, "MACOS", True):
            self.assertEqual(topology._neighbor_table_command(), ["arp", "-a"])

    def test_linux_uses_ip_neigh(self):
        with patch.object(topology, "WINDOWS", False), patch.object(topology, "MACOS", False):
            self.assertEqual(topology._neighbor_table_command(), ["ip", "neigh"])


if __name__ == "__main__":
    unittest.main()
