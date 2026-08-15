"""Standing conditions the environment scan measures, one rule at a time.

Each rule gets a pair: it fires on a realistic section, and it does *not*
fire on the healthy version of the same section. The pair is what pins the
predicate -- either test alone passes against a rule that is always on or
always off.
"""
import unittest

from netcheck import rank

from tests.test_diagnose import row


class ScanCauseTest(unittest.TestCase):
    """Standing conditions the environment scan already measures.

    A sample row says what broke *at an instant*. These say what is wrong
    *all the time* — a carrier NAT, DPI on the router, a saturated channel.
    They belong in the same ranked list because the user reads one list.
    """

    def causes(self, **sections):
        return {c["cause"]: c for c in rank.rank([row()], [], sections)}

    def test_provider_incident_outranks_every_local_cause(self):
        """The finding that stops you rebuilding a working network: when
        Anthropic is down, no amount of local repair helps."""
        got = self.causes(
            anthropic={"state": "ok", "degraded": True,
                       "indicator": "major_outage", "description": "Major outage"})
        self.assertIn("anthropic_incident", got)
        self.assertEqual(got["anthropic_incident"]["confidence"], "high")
        self.assertIn("major_outage", got["anthropic_incident"]["evidence"])

    def test_healthy_provider_is_not_a_cause(self):
        self.assertEqual(self.causes(
            anthropic={"state": "ok", "degraded": False, "indicator": "none"}), {})

    def test_private_wan_address_is_double_nat(self):
        got = self.causes(wan={"state": "ok", "ip": "192.168.0.4",
                               "double_nat": True, "cgnat": False})
        self.assertIn("double_nat", got)
        self.assertIn("192.168.0.4", got["double_nat"]["evidence"])

    def test_carrier_nat_address_is_cgnat_not_double_nat(self):
        """100.64/10 is the carrier's own shared space. Reporting it as double
        NAT would send the user into their modem to fix the ISP's network."""
        got = self.causes(wan={"state": "ok", "ip": "100.90.1.2",
                               "double_nat": False, "cgnat": True})
        self.assertIn("cgnat", got)
        self.assertNotIn("double_nat", got)

    def test_public_wan_address_is_not_a_cause(self):
        self.assertEqual(self.causes(wan={"state": "ok", "ip": "203.0.113.7",
                                          "double_nat": False, "cgnat": False}), {})

    def test_crowded_channel_is_surfaced(self):
        got = self.causes(congestion={"state": "ok", "cochannel": 6,
                                      "same_block": 2, "total_bssids": 20},
                          wifi={"state": "ok", "channel": 36})
        self.assertIn("wifi_congestion", got)
        self.assertIn("6", got["wifi_congestion"]["evidence"])

    def test_a_quiet_channel_is_not_a_cause(self):
        self.assertEqual(self.causes(
            congestion={"state": "ok", "cochannel": 1, "same_block": 0},
            wifi={"state": "ok", "channel": 36}), {})

    def test_dfs_channel_is_surfaced(self):
        """Radar on a DFS channel forces the AP off it mid-session, killing
        every established connection at once."""
        got = self.causes(wifi={"state": "ok", "channel": 52})
        self.assertIn("dfs_channel", got)

    def test_non_dfs_channel_is_not_a_cause(self):
        self.assertEqual(self.causes(wifi={"state": "ok", "channel": 149}), {})

    def test_uncorrectable_codewords_blame_the_cable_plant(self):
        got = self.causes(modem={"state": "ok", "uncorrectables": [0, 4211, 17]})
        self.assertIn("modem_signal", got)
        self.assertIn("4228", got["modem_signal"]["evidence"])

    def test_a_clean_modem_is_not_a_cause(self):
        self.assertEqual(self.causes(
            modem={"state": "ok", "uncorrectables": [0, 0]}), {})

    def test_router_dpi_enabled_is_surfaced(self):
        """ASUS AiProtection reaps long-lived TLS streams — this symptom."""
        got = self.causes(router={"state": "ok", "aiprotection_enabled": True})
        self.assertIn("router_dpi", got)

    def test_router_dpi_disabled_is_not_a_cause(self):
        self.assertEqual(self.causes(
            router={"state": "ok", "aiprotection_enabled": False}), {})

    def test_radio_power_cycles_are_surfaced(self):
        got = self.causes(events={"state": "ok", "radio_off": 3, "radio_on": 3})
        self.assertIn("radio_drops", got)

    def test_a_tunnel_carrying_the_api_route_is_surfaced(self):
        got = self.causes(tailscale={"state": "ok", "installed": True,
                                     "up": True, "in_path": True,
                                     "egress": "Tailscale"})
        self.assertIn("tailscale_in_path", got)

    def test_an_installed_tunnel_off_the_path_is_not_a_cause(self):
        self.assertEqual(self.causes(
            tailscale={"state": "ok", "installed": True, "up": True,
                       "in_path": False, "egress": "Wi-Fi"}), {})

    def test_a_reduced_mtu_is_surfaced(self):
        got = self.causes(mtu={"state": "ok", "mtu": 1400})
        self.assertIn("low_mtu", got)

    def test_a_full_mtu_is_not_a_cause(self):
        self.assertEqual(self.causes(mtu={"state": "ok", "mtu": 1500}), {})

    def test_one_broken_address_family_is_surfaced(self):
        """The fault Happy Eyeballs hides: v6 dead, v4 fine, connections
        still succeed but stall while the race times out."""
        got = self.causes(dual_stack={"state": "ok",
                                      "ipv4": {"state": "ok", "ms": 12.0},
                                      "ipv6": {"state": "fail", "ms": None,
                                               "reason": "TimeoutError: timed out"}})
        self.assertIn("broken_ipv6", got)
        self.assertIn("IPv4 reached it", got["broken_ipv6"]["evidence"])

    def test_a_broken_v4_with_working_v6_is_surfaced_too(self):
        got = self.causes(dual_stack={"state": "ok",
                                      "ipv4": {"state": "fail", "ms": None,
                                               "reason": "OSError: unreachable"},
                                      "ipv6": {"state": "ok", "ms": 9.0}})
        self.assertIn("broken_ipv4", got)

    def test_both_families_working_is_not_a_cause(self):
        self.assertEqual(self.causes(dual_stack={
            "state": "ok", "ipv4": {"state": "ok", "ms": 12.0},
            "ipv6": {"state": "ok", "ms": 14.0}}), {})

    def test_non_default_tcp_autotuning_is_surfaced(self):
        got = self.causes(tcp={"state": "ok", "autotuning": "disabled"})
        self.assertIn("tcp_autotuning", got)
        self.assertIn("disabled", got["tcp_autotuning"]["evidence"])

    def test_default_tcp_autotuning_is_not_a_cause(self):
        self.assertEqual(self.causes(
            tcp={"state": "ok", "autotuning": "normal"}), {})

    def test_a_target_with_no_ipv6_at_all_is_not_a_cause(self):
        """`unavailable` on one family means the target has no address there.
        Reporting that as a broken stack would send the user to fix IPv6 on a
        machine whose IPv6 was never in the path."""
        self.assertEqual(self.causes(dual_stack={
            "state": "ok", "ipv4": {"state": "ok", "ms": 12.0},
            "ipv6": {"state": "unavailable", "ms": None,
                     "reason": "example.test has no IPv6 address"}}), {})

    def test_both_families_down_is_left_to_the_layer_rules(self):
        """Everything being unreachable is not a dual-stack finding; the
        per-layer culprit rules already name that, and better."""
        self.assertEqual(self.causes(dual_stack={
            "state": "ok", "ipv4": {"state": "fail", "ms": None, "reason": "x"},
            "ipv6": {"state": "fail", "ms": None, "reason": "x"}}), {})

    def test_unavailable_sections_are_never_cited(self):
        """The rule that makes every section above safe: "we could not
        measure" must never read as "we measured a fault".

        Each section below carries the *fault-indicating fields too* — a
        partial or stale read, which is the realistic dangerous case. The only
        thing standing between this input and eleven false causes is the state
        gate, so dropping that gate has to turn this red. With fields omitted
        it passes either way, because the predicates read them as None.
        """
        self.assertEqual(self.causes(
            anthropic={"state": "unavailable", "reason": "no route",
                       "degraded": True, "indicator": "major_outage"},
            wan={"state": "unavailable", "reason": "no route",
                 "ip": "100.90.1.2", "double_nat": True, "cgnat": True},
            congestion={"state": "unavailable", "reason": "netsh unavailable",
                        "cochannel": 9, "same_block": 4},
            wifi={"state": "unavailable", "reason": "not associated", "channel": 52},
            modem={"state": "unavailable", "reason": "no credentials",
                   "uncorrectables": [9999]},
            router={"state": "unavailable", "reason": "no credentials",
                    "aiprotection_enabled": True},
            events={"state": "unavailable", "reason": "not Windows", "radio_off": 7},
            tailscale={"state": "unavailable", "reason": "not Windows",
                       "in_path": True, "egress": "Tailscale"},
            mtu={"state": "unavailable", "reason": "ICMP filtered", "mtu": 1200},
            tcp={"state": "unavailable", "reason": "netsh unavailable",
                 "autotuning": "disabled"},
            driver={"state": "unavailable", "reason": "not Windows",
                    "adapter": "Intel(R) Wi-Fi 6 AX201", "wireless_mode": "802.11ac"},
            exposure={"state": "unavailable", "reason": "host failed _on_lan()",
                      "findings": [{"kind": "open_port", "ip": "192.168.1.7", "port": 80}]}
        ), {})

    def test_a_failed_section_is_never_cited_either(self):
        """`fail` means the query broke, not that the thing it queries is at
        fault. Same construction: the fault fields are present, so only the
        state gate can suppress them."""
        self.assertEqual(self.causes(
            modem={"state": "fail", "reason": "HTTP 401", "uncorrectables": [4211]},
            router={"state": "fail", "reason": "HTTP 401", "aiprotection_enabled": True},
            wan={"state": "fail", "reason": "timeout", "ip": "10.0.0.1",
                 "double_nat": True, "cgnat": False},
            tcp={"state": "fail", "reason": "netsh unavailable", "autotuning": "disabled"},
            anthropic={"state": "fail", "reason": "timeout", "degraded": True,
                       "indicator": "major_outage"}), {})

    def test_every_scan_cause_carries_an_actionable_fix(self):
        """A cause with no fix is a complaint."""
        for c in rank.rank([row()], [], {
                "anthropic": {"state": "ok", "degraded": True, "indicator": "major_outage"},
                "wan": {"state": "ok", "ip": "100.90.1.2", "double_nat": False, "cgnat": True},
                "wifi": {"state": "ok", "channel": 52},
                "congestion": {"state": "ok", "cochannel": 6, "same_block": 1},
                "modem": {"state": "ok", "uncorrectables": [99]},
                "router": {"state": "ok", "aiprotection_enabled": True},
                "events": {"state": "ok", "radio_off": 2},
                "tailscale": {"state": "ok", "in_path": True},
                "mtu": {"state": "ok", "mtu": 1400},
                "tcp": {"state": "ok", "autotuning": "disabled"},
                "exposure": {"state": "ok", "findings": [
                    {"kind": "open_port", "ip": "192.168.1.7", "port": 80},
                    {"kind": "default_credential", "ip": "192.168.1.7", "entry": "DC02"}]}}):
            self.assertTrue(c["fix"], f"{c['cause']} has no fix")

    def test_open_management_port_finding_is_surfaced(self):
        got = self.causes(exposure={"state": "ok", "findings": [
            {"kind": "open_port", "ip": "192.168.1.7", "port": 80}]})
        self.assertIn("lan_open_management_port", got)
        self.assertIn("192.168.1.7:80", got["lan_open_management_port"]["evidence"])

    def test_default_credential_finding_names_only_the_list_entry(self):
        got = self.causes(exposure={"state": "ok", "findings": [
            {"kind": "default_credential", "ip": "192.168.1.7", "entry": "DC02"}]})
        self.assertIn("lan_default_credentials", got)
        self.assertIn("DC02", got["lan_default_credentials"]["evidence"])
        self.assertNotIn("admin:admin", got["lan_default_credentials"]["evidence"])


if __name__ == "__main__":
    unittest.main()
