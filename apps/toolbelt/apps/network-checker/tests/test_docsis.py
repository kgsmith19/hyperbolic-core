"""The NETGEAR DOCSIS status page: a pure parser over a real capture."""
import unittest

from netcheck import docsis

from tests import fixture


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


if __name__ == "__main__":
    unittest.main()
