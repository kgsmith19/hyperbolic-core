"""Fix recommendation likelihoods: documented priors until real measured
outcomes exist, then switch to the actual success rate.

Every FixRecommendation ships a `likelihood` that used to be a hardcoded
guess (0.35 for the Wi-Fi channel fix, 0.20 for AiProtection, etc.) with no
way to tell it apart from a number backed by real data. `likelihood_source`
now says which one a caller is looking at, and `recommend_fixes_for_
diagnosis(diagnosis, conn=...)` switches a fix's number from "prior" to
"measured" only once store.MIN_MEASURED_FIX_SAMPLES real outcomes exist for
that fix_id -- a rate computed from one or two samples is not more
trustworthy than a guess, just quieter about being one.
"""
import tempfile
import unittest
from pathlib import Path

from netcheck import fix_engine, store


class DefaultPriorTest(unittest.TestCase):
    """With no history (or no conn at all), every fix keeps its documented
    prior -- this must never regress to some other implicit default."""

    def test_no_conn_keeps_documented_priors(self):
        diagnosis = {"primary_culprit": "gateway", "synthesis_confidence": 0.85}
        fixes = fix_engine.recommend_fixes_for_diagnosis(diagnosis)

        wifi_channel = next(f for f in fixes if f.id == "wifi_channel_5ghz")
        self.assertEqual(wifi_channel.likelihood, 0.35)
        self.assertEqual(wifi_channel.likelihood_source, "prior")
        self.assertIsNone(wifi_channel.likelihood_samples)

    def test_conn_with_no_history_keeps_documented_priors(self):
        with tempfile.TemporaryDirectory() as d:
            conn = store.open_db(Path(d) / "t.db")
            diagnosis = {"primary_culprit": "router", "synthesis_confidence": 0.75}
            fixes = fix_engine.recommend_fixes_for_diagnosis(diagnosis, conn=conn)

            aiprotection = next(f for f in fixes if f.id == "disable_aiprotection")
            self.assertEqual(aiprotection.likelihood, 0.20)
            self.assertEqual(aiprotection.likelihood_source, "prior")
            conn.close()


class MeasuredOverrideTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.conn = store.open_db(Path(self.dir.name) / "t.db")
        self.host = store.host_id(self.conn, "surface", "Windows")

    def tearDown(self):
        self.conn.close()
        self.dir.cleanup()

    def test_enough_samples_switches_to_measured_rate(self):
        for i, success in enumerate([True, True, False]):
            store.record_fix_outcome(self.conn, self.host, "disable_aiprotection",
                                     success, ts=f"t{i}")

        diagnosis = {"primary_culprit": "router", "synthesis_confidence": 0.75}
        fixes = fix_engine.recommend_fixes_for_diagnosis(diagnosis, conn=self.conn)

        aiprotection = next(f for f in fixes if f.id == "disable_aiprotection")
        self.assertEqual(aiprotection.likelihood_source, "measured")
        self.assertAlmostEqual(aiprotection.likelihood, 2 / 3)
        self.assertEqual(aiprotection.likelihood_samples, 3)

    def test_too_few_samples_keeps_the_prior(self):
        store.record_fix_outcome(self.conn, self.host, "disable_aiprotection",
                                 True, ts="t0")

        diagnosis = {"primary_culprit": "router", "synthesis_confidence": 0.75}
        fixes = fix_engine.recommend_fixes_for_diagnosis(diagnosis, conn=self.conn)

        aiprotection = next(f for f in fixes if f.id == "disable_aiprotection")
        self.assertEqual(aiprotection.likelihood_source, "prior")
        self.assertEqual(aiprotection.likelihood, 0.20)

    def test_only_the_matching_fix_id_is_affected(self):
        for i in range(3):
            store.record_fix_outcome(self.conn, self.host, "disable_aiprotection",
                                     True, ts=f"t{i}")

        diagnosis = {"primary_culprit": "router", "synthesis_confidence": 0.75}
        fixes = fix_engine.recommend_fixes_for_diagnosis(diagnosis, conn=self.conn)

        qos = next(f for f in fixes if f.id == "disable_qos")
        self.assertEqual(qos.likelihood_source, "prior")
        self.assertEqual(qos.likelihood, 0.18)

    def test_measured_rate_still_participates_in_effort_first_sort(self):
        """Sort is (effort, -likelihood) -- a measured rate must sort exactly
        like a prior would, not bypass the ordering."""
        for i in range(5):
            store.record_fix_outcome(self.conn, self.host, "update_router_firmware",
                                     True, ts=f"t{i}")

        diagnosis = {"primary_culprit": "router", "synthesis_confidence": 0.75}
        fixes = fix_engine.recommend_fixes_for_diagnosis(diagnosis, conn=self.conn)
        router_fixes = [f for f in fixes if f.category == "router"]

        # update_router_firmware is "medium" effort; low-effort fixes must
        # still sort first even though its measured rate (1.0) is now the
        # highest likelihood of any router fix.
        self.assertEqual(router_fixes[-1].id, "update_router_firmware")


if __name__ == "__main__":
    unittest.main()
