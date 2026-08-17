"""Environment scan: everything measurable about this machine's network stack.

The load-bearing behaviour here is the unavailable/fail split. Sections that
need credentials must go quiet, not loud, when they have none.

This file covers the individual probes. scan()'s own composition -- which
sections it assembles and what it threads through to each collaborator --
lives in test_environ_scan.py.
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


if __name__ == "__main__":
    unittest.main()
