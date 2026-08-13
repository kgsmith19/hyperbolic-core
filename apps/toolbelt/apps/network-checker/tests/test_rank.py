"""Ranking: what to tell the user, ordered by confidence.

`culprit()` reads one row and is tested in test_diagnose.py. `rank()` reads
the whole history *and* the latest environment scan, and merges both into the
one list the CLI prints and the dashboard renders -- so the tests here are
about which findings surface, in what order, and whether each carries
something the user can act on.
"""
import unittest
from pathlib import Path

from netcheck import change_templates, rank

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
    """A cause this repo ships a change template for must say so.

    Three of the fix scripts exist for causes `diagnose` already names, and
    the fix text now points at the gated change lifecycle (05-f section 4.5)
    instead of a raw script invocation -- `run_fixes.sh` is deleted, and
    every device write goes through propose/test/approve/apply.

    The invocation is generated from a table checked against both the
    filesystem and change_templates.TEMPLATES so the three cannot drift
    apart.
    """

    def fix_for(self, cause, **sections):
        got = {c["cause"]: c for c in rank.rank([row(dns_router_state="fail")] * 3,
                                                [], sections)}
        return got[cause]["fix"]

    def test_a_dns_cause_names_the_change_lifecycle(self):
        fix = self.fix_for("router_dns")
        self.assertIn("netcheck change propose", fix)
        self.assertIn("change test", fix)
        self.assertIn("change show", fix)
        self.assertNotIn("run_fixes.sh", fix)

    def test_a_radio_cause_names_the_adapter_power_template(self):
        fix = {c["cause"]: c for c in rank.rank(
            [row()], [], {"events": {"state": "ok", "radio_off": 3}})}["radio_drops"]["fix"]
        self.assertIn("adapter_power", fix)
        self.assertIn("netcheck change propose", fix)

    def test_a_cause_with_no_template_does_not_invent_one(self):
        fix = {c["cause"]: c for c in rank.rank([row()], [], {
            "wan": {"state": "ok", "ip": "100.90.1.2",
                    "double_nat": False, "cgnat": True}})}["cgnat"]["fix"]
        self.assertNotIn("netcheck change propose", fix)

    def test_every_named_template_script_exists_on_disk(self):
        """A fix naming a template whose script was deleted is worse than no fix."""
        repo = Path(__file__).resolve().parent.parent
        for cause, name in rank._TEMPLATES.items():
            script = change_templates.TEMPLATES[name]["change_cmd"].split()[0]
            self.assertTrue((repo / script).is_file(),
                            f"{cause} names template {name!r} pointing at "
                            f"{script}, which does not exist")

    def test_every_templated_cause_is_a_real_cause(self):
        """A template wired to a cause the ranker never emits is dead wiring."""
        for cause in rank._TEMPLATES:
            self.assertIn(cause, rank._FIXES)

    def test_every_template_name_resolves(self):
        """A cause pointing at a template name missing from
        change_templates.TEMPLATES is a typo, not a feature."""
        for cause, name in rank._TEMPLATES.items():
            self.assertIn(name, change_templates.TEMPLATES)


if __name__ == "__main__":
    unittest.main()
