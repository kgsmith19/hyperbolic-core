"""Devices and services netcheck reaches over the network.

The load-bearing behaviour is the three-state split. A section that needs
credentials it does not have must report `unavailable` -- we could not
measure -- while a query that ran and broke reports `fail`. Neither may ever
be cited as a fault by the ranking engine.
"""
import unittest
from unittest.mock import patch

from netcheck import rank, remote


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
                          return_value=('{"ip": "100.90.1.2"}', None)), \
             patch.object(remote.geoip, "locate",
                          return_value={"state": "unavailable", "reason": "mocked"}):
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


class WanGeolocationTest(unittest.TestCase):
    """wan()'s composition of geoip.locate() (FR-020). Geolocation is
    enrichment attached under "geo": its failure must never leak into or
    downgrade wan()'s own state/double_nat/cgnat fields."""

    def test_a_successful_wan_lookup_attaches_geo_on_success(self):
        with patch.object(remote, "_http_get",
                          return_value=('{"ip": "203.0.113.7"}', None)), \
             patch.object(remote.geoip, "locate",
                          return_value={"state": "ok", "city": "Springfield",
                                        "region": "Oregon",
                                        "country": "United States"}):
            got = remote.wan()
        self.assertEqual(got["state"], "ok")
        self.assertEqual(got["geo"], {"state": "ok", "city": "Springfield",
                                       "region": "Oregon",
                                       "country": "United States"})

    def test_a_failing_geolocation_does_not_affect_wans_own_state(self):
        """The contract this class exists to pin down: a geolocation
        failure degrades only "geo", never wan()'s own verdict."""
        with patch.object(remote, "_http_get",
                          return_value=('{"ip": "203.0.113.7"}', None)), \
             patch.object(remote.geoip, "locate",
                          return_value={"state": "unavailable",
                                        "reason": "timeout"}):
            got = remote.wan()
        self.assertEqual(got["state"], "ok")
        self.assertEqual(got["ip"], "203.0.113.7")
        self.assertFalse(got["double_nat"])
        self.assertFalse(got["cgnat"])
        self.assertEqual(got["geo"]["state"], "unavailable")

    def test_include_geo_false_skips_the_geolocation_lookup(self):
        """FR-018: standard-tier scans ask wan() not to bother -- geoip is
        deep-tier-only surface area."""
        with patch.object(remote, "_http_get",
                          return_value=('{"ip": "203.0.113.7"}', None)), \
             patch.object(remote.geoip, "locate") as mock_locate:
            got = remote.wan(include_geo=False)
        mock_locate.assert_not_called()
        self.assertNotIn("geo", got)


class CredentialDestinationTest(unittest.TestCase):
    """Credentials reach these devices as HTTP Basic and as a plaintext
    login header, over `http://`, because that is all a modem or a consumer
    router speaks on the LAN. That is an accepted risk *on the LAN* (#30).

    Off it, it is not a risk anyone accepted. A typo in MODEM_HOST is enough
    to post the modem password to a stranger, in the clear, every scan. The
    address is checked before anything is sent.
    """

    def sent_to(self, host, section):
        """Run a credentialed section and report whether anything was sent."""
        calls = []
        with patch.object(remote, "_fetch",
                          side_effect=lambda req, *a, **k: (calls.append(req), ("", None))[1]):
            got = section(host=host, user="admin", password="hunter2")
        return got, calls

    def test_a_private_address_is_allowed(self):
        got, calls = self.sent_to("192.168.100.1", remote.modem)
        self.assertTrue(calls, "a LAN device must still be queried")
        self.assertNotEqual(got["state"], "unavailable")

    def test_loopback_is_allowed(self):
        _got, calls = self.sent_to("127.0.0.1", remote.modem)
        self.assertTrue(calls)

    def test_a_public_address_sends_nothing(self):
        """The failure this exists to prevent: one wrong digit in .env and the
        password goes to a stranger in the clear.

        A real routable address, not 203.0.113.x -- the documentation ranges
        are reserved, so `is_private` reports them private, correctly.
        """
        got, calls = self.sent_to("1.1.1.1", remote.modem)
        self.assertEqual(calls, [], "no request may be made at all")
        self.assertEqual(got["state"], "unavailable")
        self.assertIn("not on a local network", got["reason"])

    def test_the_router_path_is_guarded_too(self):
        got, calls = self.sent_to("8.8.8.8", remote.router)
        self.assertEqual(calls, [])
        self.assertEqual(got["state"], "unavailable")

    def test_a_name_that_resolves_off_lan_sends_nothing(self):
        """The check is on the address, not the spelling -- a hostname that
        resolves to a public address is the same mistake."""
        with patch.object(remote.socket, "getaddrinfo",
                          return_value=[(2, 1, 6, "", ("93.184.216.34", 80))]):
            got, calls = self.sent_to("modem.example.com", remote.modem)
        self.assertEqual(calls, [])
        self.assertEqual(got["state"], "unavailable")

    def test_a_name_resolving_to_both_lan_and_public_sends_nothing(self):
        """Every address must be local, not merely one of them. A name that
        answers with both a LAN address and a public one is the shape of DNS
        rebinding, and picking the LAN answer out of it would send the
        password to whoever controls the other."""
        with patch.object(remote.socket, "getaddrinfo", return_value=[
                (2, 1, 6, "", ("192.168.1.1", 80)),
                (2, 1, 6, "", ("93.184.216.34", 80))]):
            got, calls = self.sent_to("modem.example.com", remote.modem)
        self.assertEqual(calls, [])
        self.assertEqual(got["state"], "unavailable")

    def test_a_name_that_will_not_resolve_sends_nothing(self):
        with patch.object(remote.socket, "getaddrinfo",
                          side_effect=OSError("Name or service not known")):
            got, calls = self.sent_to("nope.invalid", remote.modem)
        self.assertEqual(calls, [])
        self.assertEqual(got["state"], "unavailable")

    def test_a_host_with_a_port_is_still_classified(self):
        _got, calls = self.sent_to("192.168.1.1:8080", remote.modem)
        self.assertTrue(calls, "a port suffix must not defeat the check")


if __name__ == "__main__":
    unittest.main()
