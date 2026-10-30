"""environ.scan() composition: which sections it assembles, what it threads
through to each collaborator, and the deep-tier branch.

Split out of test_environ.py, which keeps the per-probe parser tests. The
two files share nothing but the environ module: everything here goes
through no_live_egress() below, and nothing there calls scan() at all.
"""
import contextlib
import unittest
from unittest.mock import patch

from network_checker import environ


# Every collaborator scan() fans out to, as (owner, attribute, key). This is
# exactly scan()'s egress surface: fourteen probes plus the two deep-tier
# extras, each of which opens a socket or shells out.
#
# THE COST OF LEAVING ONE UNPATCHED IS NOT THEORETICAL. On a CI runner there
# is no router, no modem, no SSDP gateway and no Tailscale, so an unpatched
# probe does not fail fast -- it blocks to its own timeout (2s for ssdp and
# snmp, 6s for remote._fetch, 15s for probes._run, 25s and 60s for
# environ._ps). One unpatched scan() call therefore costs roughly 55 seconds
# of pure waiting. ScanTierTest below used to make five of them, which was
# ~4.5 minutes of the Toolbelt gate's wall-clock; measured locally the six
# tests spent 24.3s of wall-clock against 0.5s of CPU, i.e. 98% blocked
# rather than computing.
_SCAN_COLLABORATORS = (
    (environ, "wifi", "wifi"),
    (environ, "congestion", "congestion"),
    (environ, "driver", "driver"),
    (environ, "events", "events"),
    (environ, "tcp_globals", "tcp_globals"),
    (environ, "mtu", "mtu"),
    (environ, "tailscale", "tailscale"),
    (environ.dualstack, "dual_stack", "dual_stack"),
    (environ.remote, "modem", "modem"),
    (environ.snmp, "modem_snmp", "modem_snmp"),
    (environ.remote, "router", "router"),
    (environ.ssdp, "identify_gateway", "identify_gateway"),
    (environ.remote, "wan", "wan"),
    (environ.remote, "anthropic", "anthropic"),
    (environ.topology, "map_devices", "map_devices"),
    # Keyed distinctly: this is exposure.scan(), not the environ.scan() under
    # test, and a bare "scan" key here would read as the latter.
    (environ.exposure, "scan", "exposure_scan"),
)


# The section every patched probe returns unless a test overrides it. The
# "reason" is a sentinel, not decoration: NoLiveEgressGuardTest below asserts
# that every section of a scan() result carries it, which is how an unpatched
# probe is detected regardless of whether it happens to egress on the machine
# running the suite.
_MOCKED_SECTION = {"state": "unavailable", "reason": "patched-by-no-live-egress"}


@contextlib.contextmanager
def no_live_egress():
    """Patch every collaborator scan() fans out to; yield them keyed by name.

    Tests still exercise scan()'s REAL composition -- the dispatch, the
    deep-tier branch, the argument threading -- with no network or subprocess
    egress. Each mock defaults to an "unavailable" section, a valid state for
    every section, so a test that cares about one collaborator overrides only
    that one's return_value.

    This weakens no oracle: nothing in this file asserts on a real probe's
    RESULT, only on what scan() does with it. Adding a probe to scan() without
    adding it here reintroduces the live egress, so this tuple is the single
    place that has to stay in step with scan().
    """
    with contextlib.ExitStack() as stack:
        yield {
            key: stack.enter_context(
                patch.object(owner, attr, return_value=dict(_MOCKED_SECTION))
            )
            for owner, attr, key in _SCAN_COLLABORATORS
        }


class NoLiveEgressGuardTest(unittest.TestCase):
    """A slow test is not a failing test, and that is the trap here.

    If a probe is added to scan() and not to _SCAN_COLLABORATORS, every test
    below still PASSES -- it just quietly goes back to blocking for the
    probe's full timeout on a machine with no router or modem, which is what
    put ~4.5 minutes into the Toolbelt gate in the first place. Nothing about
    a green suite would reveal it.

    So the invariant gets its own oracle, in two complementary halves. The
    coverage half is the load-bearing one and holds anywhere: every section
    scan() returns must carry the _MOCKED_SECTION sentinel, so a probe absent
    from _SCAN_COLLABORATORS is caught by the shape of the result rather than
    by whether it happens to reach the network on this particular machine --
    a probe that short-circuits for want of credentials egresses nothing here
    and would slip past a socket trap entirely. The egress half then catches
    the residue: a probe that IS patched but still reaches out on the side."""

    @staticmethod
    def _explode(*_args, **_kwargs):
        raise AssertionError(
            "live egress: scan() reached a real socket or subprocess despite "
            "no_live_egress() -- add the new probe to _SCAN_COLLABORATORS"
        )

    def test_every_scan_section_comes_from_a_patched_probe(self):
        for deep in (False, True):
            with self.subTest(deep=deep), no_live_egress():
                got = environ.scan(deep=deep)
            unpatched = sorted(k for k, v in got.items()
                               if k != "ts" and v != _MOCKED_SECTION)
            self.assertEqual(
                unpatched, [],
                f"sections {unpatched} did not come from no_live_egress(), so scan() "
                f"ran the real probe -- add it to _SCAN_COLLABORATORS")

    def test_scan_reaches_no_socket_or_subprocess_under_no_live_egress(self):
        for deep in (False, True):
            with self.subTest(deep=deep), \
                 patch("socket.socket", self._explode), \
                 patch("socket.create_connection", self._explode), \
                 patch("subprocess.run", self._explode), \
                 patch("subprocess.Popen", self._explode), \
                 patch("subprocess.check_output", self._explode), \
                 no_live_egress():
                environ.scan(deep=deep)


class ScanShapeTest(unittest.TestCase):
    def test_every_scan_section_reports_a_valid_state_hermetically(self):
        """Verified against the real environ.scan() return value -- not a
        hand-built stand-in, which would pass no matter what scan() did.
        Every network- and subprocess-touching call is mocked, so this
        exercises scan()'s real composition with no live egress."""
        with no_live_egress() as probe:
            probe["wifi"].return_value = {"state": "ok", "channel": 44, "bssid": "aa:bb:cc:dd:ee:ff"}
            probe["tcp_globals"].return_value = {"state": "ok", "autotuning": "normal"}
            probe["mtu"].return_value = {"state": "fail", "reason": "mocked"}
            probe["tailscale"].return_value = {"state": "ok", "installed": False}
            probe["modem"].return_value = {"state": "unavailable", "reason": "no credentials"}
            probe["router"].return_value = {"state": "fail", "reason": "unreachable"}
            probe["wan"].return_value = {"state": "ok", "ip": "203.0.113.7",
                                         "double_nat": False, "cgnat": False}
            probe["anthropic"].return_value = {"state": "ok", "indicator": "none",
                                               "degraded": False}
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
    wan()'s include_geo wiring is asserted on the mock rather than on a "geo"
    key in the result, which would depend on live network reachability.

    Every test here goes through no_live_egress(). Each asserts on scan()'s
    own dispatch -- which keys it adds, what arguments it threads through --
    so a probe's real return value is never part of the oracle, and patching
    the lot removes ~55 seconds of blocking per call without touching what is
    being checked."""

    def test_standard_tier_omits_topology(self):
        with no_live_egress():
            got = environ.scan(deep=False)
        self.assertNotIn("topology", got)
        self.assertNotIn("exposure", got)

    def test_deep_tier_includes_topology(self):
        with no_live_egress():
            got = environ.scan(deep=True)
        self.assertIn("topology", got)
        self.assertIn("exposure", got)

    def test_deep_tier_wires_topology_into_exposure(self):
        topo = {"state": "ok", "devices": []}
        with no_live_egress() as probe:
            probe["map_devices"].return_value = topo
            environ.scan(deep=True)
        probe["exposure_scan"].assert_called_once_with(topo)

    def test_standard_tier_tells_wan_to_skip_geolocation(self):
        with no_live_egress() as probe:
            environ.scan(deep=False)
        probe["wan"].assert_called_once_with(include_geo=False)

    def test_deep_tier_tells_wan_to_include_geolocation(self):
        with no_live_egress() as probe:
            environ.scan(deep=True)
        probe["wan"].assert_called_once_with(include_geo=True)

    def test_scan_passes_target_to_tailscale_so_scan_and_probe_agree(self):
        """tailscale() must be checked against environ.TARGET, not a second
        hardcoded default that silently ignores a NETWORK_CHECKER_TARGET
        override."""
        with no_live_egress() as probe:
            environ.scan(deep=False)
        probe["tailscale"].assert_called_once_with(environ.TARGET)


if __name__ == "__main__":
    unittest.main()
