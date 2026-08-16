"""Culprit rules and error correlation.

The rules read across one sample row. A row is a snapshot of every layer at the
same instant, so 'which things failed together' is the whole diagnostic.
"""
import unittest

from network_checker import diagnose


def row(**kw):
    """A healthy row, overridden per test. Defaults matter: a rule that only
    fires because a field was missing is a rule that fires on everything."""
    base = {"ts": "2026-08-05T00:00:00Z", "gw_state": "ok", "hop_state": "ok",
            "inet_state": "ok", "dns_router_state": "ok", "dns_public_state": "ok",
            "tls_state": "ok", "http_state": "ok"}
    base.update(kw)
    return base


class CulpritTest(unittest.TestCase):
    def test_healthy_row_blames_nobody(self):
        self.assertIsNone(diagnose.culprit(row()))

    def test_gateway_down_is_lan(self):
        """Gateway failure alone (before ISP hop) means local link."""
        self.assertEqual(diagnose.culprit(row(gw_state="fail", hop_state="fail",
                                              inet_state="fail")), "lan")

    def test_only_gateway_failing_is_lan(self):
        """Criterion: gateway is the first hop. If ONLY gw fails (hop ok),
        that proves it's before the ISP — it's the local link/Wi-Fi."""
        self.assertEqual(diagnose.culprit(row(gw_state="fail", hop_state="ok",
                                              inet_state="ok")), "lan")

    def test_gateway_up_but_hop_down_is_isp(self):
        self.assertEqual(diagnose.culprit(row(hop_state="fail",
                                              inet_state="fail")), "isp")

    def test_hop_up_but_internet_down_is_upstream(self):
        self.assertEqual(diagnose.culprit(row(inet_state="fail")), "internet")

    def test_router_dns_failing_while_public_dns_works_is_router_dns(self):
        """The highest-value rule on this network: the router is the resolver,
        so isolating it from DNS-in-general is what makes the finding actionable.

        Explicitly test the critical condition: router fails, public works."""
        self.assertEqual(
            diagnose.culprit(row(dns_router_state="fail",
                                dns_public_state="ok")), "router_dns")

    def test_both_resolvers_failing_is_not_blamed_on_the_router(self):
        """Criterion: if BOTH router and public DNS fail, it's not a router problem.
        It's DNS-in-general or upstream. Router DNS rule only fires if public works."""
        self.assertEqual(diagnose.culprit(row(dns_router_state="fail",
                                              dns_public_state="fail")), "dns")

    def test_router_dns_ok_but_public_fails_is_not_router_dns(self):
        """Criterion: router DNS working while public fails is not a router problem.
        This is a public DNS or upstream issue, not the router."""
        self.assertIsNone(diagnose.culprit(row(dns_router_state="ok",
                                               dns_public_state="fail")))

    def test_everything_reachable_but_tls_failing_is_app_layer(self):
        """Path is fine and the endpoint is not. Points at interception, DPI,
        or the far side — never at the Wi-Fi."""
        self.assertEqual(diagnose.culprit(row(tls_state="fail")), "app")

    def test_unavailable_never_produces_a_culprit(self):
        """Criterion 9: not measuring a layer is not evidence against it."""
        self.assertIsNone(diagnose.culprit(row(gw_state="unavailable")))
        self.assertIsNone(diagnose.culprit(row(hop_state="unavailable")))
        self.assertIsNone(diagnose.culprit(row(dns_router_state="unavailable")))

    def test_unavailable_dns_router_does_not_blame_router(self):
        """Critical: if router DNS is unavailable (no credentials), we cannot
        blame it. A missing modem password is not a broken modem."""
        # Router DNS unavailable, public DNS working
        self.assertIsNone(diagnose.culprit(row(dns_router_state="unavailable",
                                               dns_public_state="ok")))

    def test_unavailable_public_dns_allows_router_to_be_blamed(self):
        """Router DNS failing while public DNS is unavailable is still router_dns
        because we can't rule out the public resolver."""
        self.assertEqual(
            diagnose.culprit(row(dns_router_state="fail",
                                dns_public_state="unavailable")), "router_dns")

    def test_lan_wins_over_downstream_symptoms(self):
        """A dead gateway makes every later probe fail; reporting five causes
        for one break would bury the real one."""
        self.assertEqual(
            diagnose.culprit(row(gw_state="fail", hop_state="fail",
                                 inet_state="fail", dns_router_state="fail",
                                 tls_state="fail", http_state="fail")), "lan")


class CorrelateTest(unittest.TestCase):
    def setUp(self):
        self.samples = [row(ts="2026-08-05T00:05:00Z", gw_state="fail",
                            hop_state="fail", inet_state="fail")]

    def err(self, ts):
        return {"ts": ts, "kind": "network", "detail": "ECONNRESET"}

    def test_error_inside_the_window_takes_the_sample_verdict(self):
        got = diagnose.correlate([self.err("2026-08-05T00:06:00Z")], self.samples)
        self.assertEqual(got[0]["verdict"], "lan")

    def test_boundary_is_inclusive_at_exactly_the_window(self):
        """Criterion 8."""
        got = diagnose.correlate([self.err("2026-08-05T00:07:00Z")], self.samples)
        self.assertEqual(got[0]["verdict"], "lan")

    def test_just_outside_the_window_counts_as_unmonitored(self):
        """Having samples elsewhere in the database is not the same as having
        been watching *then*, so this must not read as a clean verdict."""
        got = diagnose.correlate([self.err("2026-08-05T00:07:01Z")], self.samples)
        self.assertEqual(got[0]["verdict"], "unmonitored")

    def test_error_during_a_healthy_sample_is_not_our_network(self):
        """The finding that stops you rebuilding a working network."""
        got = diagnose.correlate([self.err("2026-08-05T00:05:10Z")], [row(
            ts="2026-08-05T00:05:00Z")])
        self.assertEqual(got[0]["verdict"], "not_local")

    def test_error_with_no_samples_at_all_is_unmonitored(self):
        """Distinct from 'unexplained': we were not watching, so we cannot say."""
        got = diagnose.correlate([self.err("2026-08-05T00:05:10Z")], [])
        self.assertEqual(got[0]["verdict"], "unmonitored")


class BurstTest(unittest.TestCase):
    def test_errors_within_the_gap_form_one_burst(self):
        """Real outages produce clusters. Counting 4 errors from one 20-second
        dropout as 4 incidents overstates how often the link breaks."""
        errs = [{"ts": f"2026-08-05T00:00:0{s}Z"} for s in (1, 2, 3)]
        self.assertEqual(len(diagnose.bursts(errs, gap_s=60)), 1)

    def test_errors_beyond_the_gap_are_separate_bursts(self):
        errs = [{"ts": "2026-08-05T00:00:01Z"}, {"ts": "2026-08-05T02:00:00Z"}]
        self.assertEqual(len(diagnose.bursts(errs, gap_s=60)), 2)

    def test_burst_reports_its_span_and_size(self):
        errs = [{"ts": "2026-08-05T00:00:00Z"}, {"ts": "2026-08-05T00:00:20Z"}]
        b = diagnose.bursts(errs, gap_s=60)[0]
        self.assertEqual(b["count"], 2)
        self.assertEqual(b["span_s"], 20)


if __name__ == "__main__":
    unittest.main()
