"""Devices and services netcheck reaches over the network.

The load-bearing behaviour is the three-state split. A section that needs
credentials it does not have must report `unavailable` -- we could not
measure -- while a query that ran and broke reports `fail`. Neither may ever
be cited as a fault by the ranking engine.
"""
import unittest
from unittest.mock import patch

from netcheck import docsis, rank, remote

from tests import fixture


class CredentialGateTest(unittest.TestCase):
    def test_modem_without_credentials_is_unavailable(self):
        got = remote.modem(host="192.168.100.1", user=None, password=None)
        self.assertEqual(got["state"], "unavailable")
        self.assertIn("credential", got["reason"].lower())

    def test_router_without_credentials_is_unavailable(self):
        got = remote.router(host="192.168.50.1", user=None, password=None)
        self.assertEqual(got["state"], "unavailable")
        self.assertIn("credential", got["reason"].lower())

    def test_unavailable_sections_are_never_cited_as_a_cause(self):
        """A missing modem password must not read as a broken modem."""
        scan = {"modem": {"state": "unavailable", "reason": "no credentials"},
                "router": {"state": "unavailable", "reason": "no credentials"},
                "driver": {"state": "unavailable", "reason": "not Windows"}}
        self.assertEqual(rank.rank([], [], scan), [])


class ParseDocsisStatusTest(unittest.TestCase):
    """The channel tables never appear as HTML text — NETGEAR's firmware
    assigns a pipe-delimited string to a JS `tagValueList` inside each
    Init*TagValue() function, and the page's own script splits and renders it
    client-side. Real capture from a NETGEAR CAX80 (tests/fixtures/), with
    each function body also carrying a stale example inside a /* */ comment
    that a naive extraction would pick up instead of the live data.
    """

    def setUp(self):
        js = fixture("docsis_status_adv.js")
        self.got = docsis.parse_docsis_status(js)

    def test_summary_fields(self):
        self.assertEqual(self.got["state"], "ok")
        self.assertEqual(self.got["connectivity"], "OK")
        self.assertEqual(self.got["boot_state"], "OK")
        self.assertEqual(self.got["security"], "Enabled")
        self.assertEqual(self.got["uptime"], "02:51:08")

    def test_downstream_channel_count_and_a_known_row(self):
        self.assertEqual(len(self.got["downstream"]), 32)
        ch1 = self.got["downstream"][0]
        self.assertEqual(ch1["lock_status"], "Locked")
        self.assertEqual(ch1["modulation"], "256 QAM")
        self.assertEqual(ch1["frequency_hz"], 657000000)
        self.assertEqual(ch1["power_dbmv"], -2.2)
        self.assertEqual(ch1["snr_db"], 41.8)
        self.assertEqual(ch1["correctables"], 3)
        self.assertEqual(ch1["uncorrectables"], 0)

    def test_unlocked_downstream_rows_still_parse(self):
        """'Not Locked' rows use bare numbers with no dB/dBmV/Hz suffix —
        a different format from active channels on the same table."""
        ch25 = self.got["downstream"][24]
        self.assertEqual(ch25["lock_status"], "Not Locked")
        self.assertEqual(ch25["power_dbmv"], 0.0)

    def test_upstream_channels(self):
        self.assertEqual(len(self.got["upstream"]), 8)
        ch1 = self.got["upstream"][0]
        self.assertEqual(ch1["channel_type"], "ATDMA")
        self.assertEqual(ch1["frequency_hz"], 17600000)
        self.assertEqual(ch1["power_dbmv"], 41.3)

    def test_downstream_ofdm_channel_with_large_codeword_counts(self):
        ofdm = self.got["downstream_ofdm"][0]
        self.assertEqual(ofdm["frequency_hz"], 516000000)
        self.assertEqual(ofdm["unerrored"], 185404237)
        self.assertEqual(ofdm["correctable"], 167393611)
        self.assertEqual(ofdm["uncorrectable"], 0)

    def test_upstream_ofdma_channels(self):
        self.assertEqual(len(self.got["upstream_ofdma"]), 2)

    def test_summary_lists_exclude_unlocked_placeholder_channels(self):
        """The 8 unlocked DS channels report power=0.0/snr=0.0 — real zeros
        would be indistinguishable from a genuinely perfect channel, so they
        must never enter an average or a min/max."""
        self.assertEqual(len(self.got["snr_db"]), 25)      # 24 DS QAM + 1 OFDM, locked
        self.assertNotIn(0.0, self.got["snr_db"])

    def test_uncorrectables_summary_is_all_zero_on_this_real_capture(self):
        """The headline finding this parser exists to surface."""
        self.assertTrue(self.got["uncorrectables"])
        self.assertEqual(sum(self.got["uncorrectables"]), 0)

    def test_missing_table_yields_an_empty_list_not_a_crash(self):
        stripped = fixture("docsis_status_adv.js")
        stripped = stripped.split("function InitUsOfdmaTableTagValue")[0]
        got = docsis.parse_docsis_status(stripped)
        self.assertEqual(got["upstream_ofdma"], [])
        self.assertEqual(len(got["downstream"]), 32)  # unaffected sections unaffected

    def test_empty_input_is_a_clean_empty_result_not_a_crash(self):
        got = docsis.parse_docsis_status("")
        self.assertEqual(got["downstream"], [])
        self.assertEqual(got["snr_db"], [])


class ClassifyWanTest(unittest.TestCase):
    """What a WAN address says about the NAT in front of us. Pure function
    over a string, so the classification is tested without a network."""

    def test_rfc1918_address_means_the_modem_is_not_bridged(self):
        got = remote.classify_wan("192.168.0.4")
        self.assertEqual(got["state"], "ok")
        self.assertTrue(got["double_nat"])
        self.assertFalse(got["cgnat"])

    def test_carrier_nat_range_is_cgnat_and_not_double_nat(self):
        """100.64.0.0/10 is RFC 6598 carrier space. ipaddress.is_private
        counts it as private on older Pythons, which would misreport the
        ISP's own NAT as the user's modem misconfigured."""
        got = remote.classify_wan("100.90.1.2")
        self.assertTrue(got["cgnat"])
        self.assertFalse(got["double_nat"])

    def test_the_boundaries_of_the_carrier_range_are_inside_it(self):
        for ip in ("100.64.0.0", "100.127.255.255"):
            self.assertTrue(remote.classify_wan(ip)["cgnat"], ip)

    def test_addresses_just_outside_the_carrier_range_are_not_cgnat(self):
        for ip in ("100.63.255.255", "100.128.0.0"):
            self.assertFalse(remote.classify_wan(ip)["cgnat"], ip)

    def test_a_public_address_is_neither(self):
        got = remote.classify_wan("203.0.113.7")
        self.assertFalse(got["double_nat"])
        self.assertFalse(got["cgnat"])

    def test_loopback_is_not_reported_as_double_nat(self):
        """Deliberately narrower than ipaddress.is_private: only RFC 1918
        means 'something is NATing us'."""
        self.assertFalse(remote.classify_wan("127.0.0.1")["double_nat"])

    def test_a_non_address_is_unavailable_not_a_fault(self):
        for value in (None, "", "not-an-ip"):
            self.assertEqual(remote.classify_wan(value)["state"], "unavailable")


class RemoteSectionTest(unittest.TestCase):
    """wan() and anthropic() are the two sections that ask the internet a
    question. Both must degrade to a state, never raise."""

    def test_wan_classifies_the_address_the_service_returns(self):
        with patch.object(remote, "_http_get",
                          return_value=('{"ip": "100.90.1.2"}', None)):
            self.assertTrue(remote.wan()["cgnat"])

    def test_wan_without_a_route_is_a_failed_query_not_a_verdict(self):
        with patch.object(remote, "_http_get", return_value=(None, "URLError: no route")):
            got = remote.wan()
        self.assertEqual(got["state"], "fail")
        self.assertNotIn("double_nat", got)

    def test_wan_with_junk_in_the_reply_is_unavailable(self):
        with patch.object(remote, "_http_get", return_value=("<html>502</html>", None)):
            self.assertEqual(remote.wan()["state"], "unavailable")

    def test_a_declared_outage_reads_as_degraded(self):
        body = '{"status": {"indicator": "major_outage", "description": "Major outage"}}'
        with patch.object(remote, "_http_get", return_value=(body, None)):
            got = remote.anthropic()
        self.assertEqual(got["state"], "ok")
        self.assertTrue(got["degraded"])
        self.assertEqual(got["indicator"], "major_outage")

    def test_normal_operation_is_not_degraded(self):
        body = '{"status": {"indicator": "none", "description": "All Systems Operational"}}'
        with patch.object(remote, "_http_get", return_value=(body, None)):
            self.assertFalse(remote.anthropic()["degraded"])

    def test_an_unreachable_status_page_is_never_read_as_healthy(self):
        """The dangerous default: if we cannot reach status.anthropic.com we
        must not conclude the service is fine, because being unable to reach
        it is itself consistent with the outage we are diagnosing."""
        with patch.object(remote, "_http_get", return_value=(None, "URLError: timeout")):
            got = remote.anthropic()
        self.assertEqual(got["state"], "fail")
        self.assertNotIn("degraded", got)


if __name__ == "__main__":
    unittest.main()
