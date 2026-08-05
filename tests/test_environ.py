"""Environment scan: everything measurable about this machine's network stack.

The load-bearing behaviour here is the unavailable/fail split. Sections that
need credentials must go quiet, not loud, when they have none.
"""
import unittest
from pathlib import Path

from netcheck import diagnose, environ

FIXTURES = Path(__file__).parent / "fixtures"


class CredentialGateTest(unittest.TestCase):
    def test_modem_without_credentials_is_unavailable(self):
        got = environ.modem(host="192.168.100.1", user=None, password=None)
        self.assertEqual(got["state"], "unavailable")
        self.assertIn("credential", got["reason"].lower())

    def test_router_without_credentials_is_unavailable(self):
        got = environ.router(host="192.168.50.1", user=None, password=None)
        self.assertEqual(got["state"], "unavailable")
        self.assertIn("credential", got["reason"].lower())

    def test_unavailable_sections_are_never_cited_as_a_cause(self):
        """A missing modem password must not read as a broken modem."""
        scan = {"modem": {"state": "unavailable", "reason": "no credentials"},
                "router": {"state": "unavailable", "reason": "no credentials"},
                "driver": {"state": "unavailable", "reason": "not Windows"}}
        self.assertEqual(diagnose.rank([], [], scan), [])


class DriverFindingsTest(unittest.TestCase):
    def test_capable_card_at_full_mode_is_not_flagged(self):
        scan = {"driver": {"state": "ok", "adapter": "Intel(R) Wi-Fi 6 AX201 160MHz",
                           "wireless_mode": "5. 802.11ax"}}
        self.assertEqual(diagnose.rank([], [], scan), [])

    def test_pinned_card_is_flagged_with_the_actual_setting_quoted(self):
        scan = {"driver": {"state": "ok", "adapter": "Intel(R) Wi-Fi 6 AX201 160MHz",
                           "wireless_mode": "3. 802.11ac"}}
        got = diagnose.rank([], [], scan)[0]
        self.assertEqual(got["cause"], "wifi_mode_pinned")
        self.assertIn("802.11ac", got["evidence"])


class ParseDocsisStatusTest(unittest.TestCase):
    """The channel tables never appear as HTML text — NETGEAR's firmware
    assigns a pipe-delimited string to a JS `tagValueList` inside each
    Init*TagValue() function, and the page's own script splits and renders it
    client-side. Real capture from a NETGEAR CAX80 (tests/fixtures/), with
    each function body also carrying a stale example inside a /* */ comment
    that a naive extraction would pick up instead of the live data.
    """

    def setUp(self):
        js = (FIXTURES / "docsis_status_adv.js").read_text(encoding="utf-8")
        self.got = environ.parse_docsis_status(js)

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
        stripped = (FIXTURES / "docsis_status_adv.js").read_text(encoding="utf-8")
        stripped = stripped.split("function InitUsOfdmaTableTagValue")[0]
        got = environ.parse_docsis_status(stripped)
        self.assertEqual(got["upstream_ofdma"], [])
        self.assertEqual(len(got["downstream"]), 32)  # unaffected sections unaffected

    def test_empty_input_is_a_clean_empty_result_not_a_crash(self):
        got = environ.parse_docsis_status("")
        self.assertEqual(got["downstream"], [])
        self.assertEqual(got["snr_db"], [])


class ScanShapeTest(unittest.TestCase):
    def test_every_section_reports_a_state(self):
        """A section that returns bare data cannot be told apart from one that
        failed, so the shape is enforced rather than trusted."""
        got = environ.scan()
        for name, section in got.items():
            if name == "ts":
                continue
            self.assertIn("state", section, f"section {name!r} has no state")
            self.assertIn(section["state"], ("ok", "fail", "unavailable"), name)


if __name__ == "__main__":
    unittest.main()
