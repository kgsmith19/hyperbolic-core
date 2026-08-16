"""Environment scan: everything measurable about this machine's network stack.

The load-bearing behaviour here is the unavailable/fail split. Sections that
need credentials must go quiet, not loud, when they have none.
"""
import unittest
from unittest.mock import patch, MagicMock

from network_checker import environ, rank


class WifiPlatformDispatchTest(unittest.TestCase):
    """wifi() shells out to a different tool per platform; each parser is
    tested on its own merits in test_probes.py, so this only checks that
    the right tool gets called and its output reaches the right parser."""

    def test_macos_uses_airport_and_the_airport_parser(self):
        with patch("network_checker.environ.MACOS", True), \
             patch("network_checker.probes._run", return_value=("state: running\nSSID: x\nchannel: 44,80\n", "ok")) as mock_run:
            result = environ.wifi()

        self.assertEqual(result["state"], "ok")
        self.assertEqual(result["ssid"], "x")
        self.assertIn("airport", mock_run.call_args[0][0][0])

    def test_macos_missing_airport_binary_is_unavailable_not_fail(self):
        with patch("network_checker.environ.MACOS", True), \
             patch("network_checker.probes._run", return_value=("", "unavailable")):
            result = environ.wifi()

        self.assertEqual(result["state"], "unavailable")

    def test_non_macos_still_uses_netsh(self):
        with patch("network_checker.environ.MACOS", False), \
             patch("network_checker.probes._run", return_value=("State : disconnected\n", "ok")) as mock_run:
            environ.wifi()

        self.assertEqual(mock_run.call_args[0][0][0], "netsh")


class PowerShellArgumentSafetyTest(unittest.TestCase):
    """A caller-supplied value must never be interpolated into the
    PowerShell script text -- passed as a separate subprocess argument
    instead, so a value containing a quote can't break out of the script
    and inject additional commands. Not exploitable
    today (both callers only ever pass their own literal defaults), but the
    parameters invite the bug, so this locks the safe shape in with a test
    rather than relying on nobody ever wiring a caller-supplied value
    through."""

    def _run_with_mocked_powershell(self, fn, malicious):
        with patch("network_checker.environ.WINDOWS", True), \
             patch("network_checker.environ.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(stdout="", stderr="", returncode=0)
            fn(malicious)
        return mock_run.call_args[0][0]

    def test_driver_passes_name_as_a_subprocess_argument_not_interpolated(self):
        malicious = "Wi-Fi'; Remove-Item C:\\ -Recurse -Force #"
        argv = self._run_with_mocked_powershell(environ.driver, malicious)

        command_index = argv.index("-Command")
        script = argv[command_index + 1]
        self.assertNotIn(malicious, script,
                        "value must not be interpolated into the script text")
        self.assertIn(malicious, argv[command_index + 2:],
                     "value must be passed as its own subprocess argument")

    def test_tailscale_passes_target_as_a_subprocess_argument_not_interpolated(self):
        malicious = "x'; Remove-Item C:\\ -Recurse -Force #"
        argv = self._run_with_mocked_powershell(environ.tailscale, malicious)

        command_index = argv.index("-Command")
        script = argv[command_index + 1]
        self.assertNotIn(malicious, script,
                        "value must not be interpolated into the script text")
        self.assertIn(malicious, argv[command_index + 2:],
                     "value must be passed as its own subprocess argument")


class DriverFindingsTest(unittest.TestCase):
    def test_capable_card_at_full_mode_is_not_flagged(self):
        scan = {"driver": {"state": "ok", "adapter": "Intel(R) Wi-Fi 6 AX201 160MHz",
                           "wireless_mode": "5. 802.11ax"}}
        self.assertEqual(rank.rank([], [], scan), [])

    def test_pinned_card_is_flagged_with_the_actual_setting_quoted(self):
        scan = {"driver": {"state": "ok", "adapter": "Intel(R) Wi-Fi 6 AX201 160MHz",
                           "wireless_mode": "3. 802.11ac"}}
        got = rank.rank([], [], scan)[0]
        self.assertEqual(got["cause"], "wifi_mode_pinned")
        self.assertIn("802.11ac", got["evidence"])


class MtuWalkTest(unittest.TestCase):
    """environ.mtu() walks the DF bit down until a packet gets through.

    The fault it exists to catch is a path that silently drops full-size
    packets — a tunnel, a PPPoE link, a hop with a smaller MTU. Driven here
    through probes._run so the walk itself is tested rather than the local
    machine's own loopback, which has nothing to say about a real path.
    """

    OK = ("1 packets transmitted, 1 packets received, 0.0% packet loss\n"
          "round-trip min/avg/max/stddev = 1.0/1.0/1.0/0.0 ms\n")
    TOO_BIG = "ping: local error: message too long, mtu=900\n"

    def fits_under(self, limit):
        """Stand in for a path whose real MTU is `limit`: any DF-set probe
        larger than it comes back 'message too long', like a real hop would."""
        def run(cmd, _timeout=None):
            size = int(cmd[cmd.index("-s") + 1] if "-s" in cmd
                       else cmd[cmd.index("-l") + 1])
            return (self.OK, "ok") if size + 28 <= limit else (self.TOO_BIG, "ok")
        return run

    def test_the_walk_stops_at_the_largest_candidate_that_fits(self):
        """Not merely 'some size worked' — the first candidate that fits
        wins, so the answer is a lower bound on the path MTU rather than a
        smaller lucky guess. On a 1400-byte path the candidates 1500/1488/
        1468/1428 are all too big and 1328 is the first that fits."""
        with patch.object(environ.probes, "_run", side_effect=self.fits_under(1400)):
            got = environ.mtu("192.0.2.1")
        self.assertEqual(got["state"], "ok")
        self.assertEqual(got["mtu"], 1328)

    def test_a_full_size_path_reports_1500(self):
        with patch.object(environ.probes, "_run", side_effect=self.fits_under(1500)):
            self.assertEqual(environ.mtu("192.0.2.1")["mtu"], 1500)

    def test_a_path_below_every_candidate_is_unavailable_not_a_false_ok(self):
        """The dangerous failure: reporting a healthy MTU for a path where
        nothing we tried got through. `unavailable` says we could not measure
        it; a number would say we did."""
        with patch.object(environ.probes, "_run", side_effect=self.fits_under(600)):
            got = environ.mtu("192.0.2.1")
        self.assertEqual(got["state"], "unavailable")
        self.assertNotIn("mtu", got)

    def test_a_missing_ping_binary_is_unavailable_not_a_fault(self):
        with patch.object(environ.probes, "_run", return_value=(None, "unavailable")):
            self.assertEqual(environ.mtu("192.0.2.1")["state"], "unavailable")

    def test_the_caller_chooses_the_candidate_sizes(self):
        """`sizes` is what makes a narrower second pass possible after a
        coarse first one."""
        with patch.object(environ.probes, "_run", side_effect=self.fits_under(900)):
            got = environ.mtu("192.0.2.1", sizes=(1172, 872, 472))
        self.assertEqual(got["mtu"], 900)


class ScanShapeTest(unittest.TestCase):
    def test_every_scan_section_reports_a_valid_state_hermetically(self):
        """Verified against the real environ.scan() return value -- not a
        hand-built stand-in, which would pass no matter what scan() did.
        Every network- and subprocess-touching call is mocked, so this
        exercises scan()'s real composition with no live egress."""
        with patch.object(environ, "wifi", return_value={"state": "ok", "channel": 44, "bssid": "aa:bb:cc:dd:ee:ff"}), \
             patch.object(environ, "congestion", return_value={"state": "unavailable", "reason": "mocked"}), \
             patch.object(environ, "driver", return_value={"state": "unavailable", "reason": "mocked"}), \
             patch.object(environ, "events", return_value={"state": "unavailable", "reason": "mocked"}), \
             patch.object(environ, "tcp_globals", return_value={"state": "ok", "autotuning": "normal"}), \
             patch.object(environ, "mtu", return_value={"state": "fail", "reason": "mocked"}), \
             patch.object(environ, "tailscale", return_value={"state": "ok", "installed": False}), \
             patch.object(environ.dualstack, "dual_stack", return_value={"state": "unavailable"}), \
             patch.object(environ.remote, "modem", return_value={"state": "unavailable", "reason": "no credentials"}), \
             patch.object(environ.snmp, "modem_snmp", return_value={"state": "unavailable"}), \
             patch.object(environ.remote, "router", return_value={"state": "fail", "reason": "unreachable"}), \
             patch.object(environ.ssdp, "identify_gateway", return_value={"state": "unavailable"}), \
             patch.object(environ.remote, "wan", return_value={"state": "ok", "ip": "203.0.113.7",
                                                               "double_nat": False, "cgnat": False}), \
             patch.object(environ.remote, "anthropic", return_value={"state": "ok", "indicator": "none",
                                                                      "degraded": False}):
            got = environ.scan(deep=False)

        for name, section in got.items():
            if name == "ts":
                continue
            self.assertIn("state", section, f"section {name!r} has no state field")
            self.assertIn(section["state"], ("ok", "fail", "unavailable"),
                         f"section {name!r} has invalid state: {section['state']}")
        # Spot-check that each mock actually threads through to its own named
        # key, not merely that *some* section somewhere has a valid state.
        self.assertEqual(got["router"]["state"], "fail")
        self.assertEqual(got["modem"]["state"], "unavailable")
        self.assertEqual(got["wan"]["state"], "ok")


class ScanTierTest(unittest.TestCase):
    """FR-018/019: deep tier adds topology and exposure; standard omits both.
    wan()'s include_geo wiring is mocked instead, since asserting on "geo"
    directly would depend on live network reachability."""

    def test_standard_tier_omits_topology(self):
        got = environ.scan(deep=False)
        self.assertNotIn("topology", got)
        self.assertNotIn("exposure", got)

    def test_deep_tier_includes_topology(self):
        got = environ.scan(deep=True)
        self.assertIn("topology", got)
        self.assertIn("exposure", got)

    def test_deep_tier_wires_topology_into_exposure(self):
        topo = {"state": "ok", "devices": []}
        with patch.object(environ, "wifi", return_value={"state": "ok", "channel": None,
                                                         "bssid": None}), \
             patch.object(environ, "congestion", return_value={"state": "unavailable"}), \
             patch.object(environ, "driver", return_value={"state": "unavailable"}), \
             patch.object(environ, "events", return_value={"state": "unavailable"}), \
             patch.object(environ, "tcp_globals", return_value={"state": "unavailable"}), \
             patch.object(environ, "mtu", return_value={"state": "unavailable"}), \
             patch.object(environ, "tailscale", return_value={"state": "unavailable"}), \
             patch.object(environ.dualstack, "dual_stack", return_value={"state": "unavailable"}), \
             patch.object(environ.remote, "modem", return_value={"state": "unavailable"}), \
             patch.object(environ.snmp, "modem_snmp", return_value={"state": "unavailable"}), \
             patch.object(environ.remote, "router", return_value={"state": "unavailable"}), \
             patch.object(environ.ssdp, "identify_gateway", return_value={"state": "unavailable"}), \
             patch.object(environ.remote, "wan", return_value={"state": "unavailable"}), \
             patch.object(environ.remote, "anthropic", return_value={"state": "unavailable"}), \
             patch.object(environ.topology, "map_devices", return_value=topo), \
             patch.object(environ.exposure, "scan",
                          return_value={"state": "ok", "devices": [], "findings": []}) as mock_scan:
            environ.scan(deep=True)
        mock_scan.assert_called_once_with(topo)

    def test_standard_tier_tells_wan_to_skip_geolocation(self):
        with patch.object(environ.remote, "wan") as mock_wan:
            environ.scan(deep=False)
        mock_wan.assert_called_once_with(include_geo=False)

    def test_deep_tier_tells_wan_to_include_geolocation(self):
        with patch.object(environ.remote, "wan") as mock_wan:
            environ.scan(deep=True)
        mock_wan.assert_called_once_with(include_geo=True)

    def test_scan_passes_target_to_tailscale_so_scan_and_probe_agree(self):
        """tailscale() must be checked against environ.TARGET, not a second
        hardcoded default that silently ignores a NETWORK_CHECKER_TARGET
        override."""
        with patch.object(environ, "tailscale") as mock_tailscale:
            environ.scan(deep=False)
        mock_tailscale.assert_called_once_with(environ.TARGET)


if __name__ == "__main__":
    unittest.main()
