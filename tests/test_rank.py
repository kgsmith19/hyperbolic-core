"""Ranking: what to tell the user, ordered by confidence.

`culprit()` reads one row and is tested in test_diagnose.py. `rank()` reads
the whole history *and* the latest environment scan, and merges both into the
one list the CLI prints and the dashboard renders -- so the tests here are
about which findings surface, in what order, and whether each carries
something the user can act on.
"""
import unittest
from pathlib import Path

from netcheck import rank

from tests.test_diagnose import row


class RankTest(unittest.TestCase):
    def test_repeated_router_dns_failures_are_ranked_and_actionable(self):
        samples = [row(ts=f"2026-08-05T00:0{i}:00Z", dns_router_state="fail")
                   for i in range(5)]
        causes = rank.rank(samples, [], {})
        self.assertEqual(causes[0]["cause"], "router_dns")
        self.assertIn("evidence", causes[0])
        self.assertTrue(causes[0]["fix"])

    def test_a_healthy_history_reports_no_causes(self):
        self.assertEqual(rank.rank([row()] * 5, [], {}), [])

    def test_unavailable_sections_are_never_cited_as_evidence(self):
        """Criterion 9 through to the report."""
        causes = rank.rank([row(gw_state="unavailable")] * 5, [], {})
        self.assertEqual(causes, [])

    def test_wireless_mode_pinned_below_capability_is_surfaced(self):
        """A Wi-Fi 6 card pinned to 802.11ac is a deliberate setting worth
        reporting; it is invisible unless something looks for it."""
        causes = rank.rank([row()], [], {
            "driver": {"state": "ok", "adapter": "Intel(R) Wi-Fi 6 AX201 160MHz",
                       "wireless_mode": "3. 802.11ac"}})
        self.assertTrue(any(c["cause"] == "wifi_mode_pinned" for c in causes))


class ScriptedFixTest(unittest.TestCase):
    """A cause this repo ships a script for must say so.

    Three of the fix scripts exist for causes `diagnose` already names, and
    nothing connected the two: the user read "set the adapter's DNS to
    1.1.1.1" and did it by hand, with tools/fix_dns.sh sitting unmentioned in
    the repo. That is the "recommendation" half of #31 -- the scripts were
    built, they were just never recommended.

    The invocation is generated from a table rather than written into the
    prose so the two cannot drift apart.
    """

    def fix_for(self, cause, **sections):
        got = {c["cause"]: c for c in rank.rank([row(dns_router_state="fail")] * 3,
                                                [], sections)}
        return got[cause]["fix"]

    def test_a_dns_cause_names_the_dns_script(self):
        fix = self.fix_for("router_dns")
        self.assertIn("run_fixes.sh --dns-only", fix)
        self.assertIn("--dry-run", fix, "the safe invocation comes first")

    def test_a_radio_cause_names_the_adapter_script(self):
        fix = {c["cause"]: c for c in rank.rank(
            [row()], [], {"events": {"state": "ok", "radio_off": 3}})}["radio_drops"]["fix"]
        self.assertIn("run_fixes.sh --adapter-only", fix)

    def test_a_cause_with_no_script_does_not_invent_one(self):
        fix = {c["cause"]: c for c in rank.rank([row()], [], {
            "wan": {"state": "ok", "ip": "100.90.1.2",
                    "double_nat": False, "cgnat": True}})}["cgnat"]["fix"]
        self.assertNotIn("run_fixes.sh", fix)

    def test_every_named_script_exists_on_disk(self):
        """A fix naming a script that was deleted is worse than no fix."""
        repo = Path(__file__).resolve().parent.parent
        for cause, invocation in rank._SCRIPTS.items():
            script = invocation.split()[0]
            self.assertTrue((repo / script).is_file(),
                            f"{cause} names {script}, which does not exist")

    def test_every_scripted_cause_is_a_real_cause(self):
        """A script wired to a cause the ranker never emits is dead wiring."""
        for cause in rank._SCRIPTS:
            self.assertIn(cause, rank._FIXES)


if __name__ == "__main__":
    unittest.main()
