"""Pure compare() math for FR-021's controlled-comparison mode (UC-006): no
I/O, no database -- just median latency and ok/fail/unavailable state-mix
over two lists of already-stored sample dicts. The critical property is the
failure path: a label with zero samples must be reported as having no data,
never a fabricated comparison value.
"""
import unittest

from network_checker import experiment


def _row(gw_state="ok", gw_ms=10.0):
    """A minimal stored-sample dict: every layer 'ok' with no latency except
    gw, which the tests vary."""
    row = {"gw_state": gw_state, "gw_ms": gw_ms}
    for layer in ("hop", "inet", "dns_router", "dns_public", "tls", "http"):
        row[f"{layer}_state"] = "ok"
        row[f"{layer}_ms"] = None
    return row


class CompareTest(unittest.TestCase):
    def test_two_labeled_sides_report_median_and_state_mix_per_layer(self):
        a = [_row(gw_ms=10.0), _row(gw_ms=20.0), _row(gw_ms=30.0)]
        b = [_row(gw_state="fail", gw_ms=None), _row(gw_ms=5.0)]
        result = experiment.compare(a, b)

        self.assertTrue(result["a"]["has_data"])
        self.assertEqual(result["a"]["count"], 3)
        self.assertEqual(result["a"]["layers"]["gw"]["median_ms"], 20.0)
        self.assertEqual(result["a"]["layers"]["gw"]["state_mix"],
                         {"ok": 3, "fail": 0, "unavailable": 0})

        self.assertTrue(result["b"]["has_data"])
        self.assertEqual(result["b"]["layers"]["gw"]["median_ms"], 5.0)
        self.assertEqual(result["b"]["layers"]["gw"]["state_mix"],
                         {"ok": 1, "fail": 1, "unavailable": 0})

    def test_even_sample_count_median_averages_the_two_middle_values(self):
        rows = [_row(gw_ms=10.0), _row(gw_ms=20.0)]
        result = experiment.compare(rows, [])
        self.assertEqual(result["a"]["layers"]["gw"]["median_ms"], 15.0)

    def test_unavailable_layer_counts_toward_state_mix_not_median(self):
        rows = [_row(gw_state="unavailable", gw_ms=None), _row(gw_ms=10.0)]
        result = experiment.compare(rows, [])
        layer = result["a"]["layers"]["gw"]
        self.assertEqual(layer["state_mix"],
                         {"ok": 1, "fail": 0, "unavailable": 1})
        self.assertEqual(layer["median_ms"], 10.0)

    def test_empty_side_reports_no_data_never_a_fabricated_value(self):
        """Failure path (FR-021 acceptance criterion): a label with zero
        stored samples must not produce comparison numbers on that side."""
        result = experiment.compare([_row()], [])
        self.assertFalse(result["b"]["has_data"])
        self.assertEqual(result["b"]["count"], 0)
        self.assertEqual(result["b"]["layers"], {})

    def test_both_sides_empty_reports_no_data_for_both(self):
        result = experiment.compare([], [])
        self.assertFalse(result["a"]["has_data"])
        self.assertFalse(result["b"]["has_data"])


class FormatReportTest(unittest.TestCase):
    def test_report_is_ascii_only_and_names_the_no_data_side(self):
        result = experiment.compare([_row()], [])
        text = experiment.format_report("wifi", "ethernet", result)
        self.assertTrue(all(ord(c) < 128 for c in text), "console codepage-unsafe character")
        self.assertIn("no data", text)

    def test_no_comparison_numbers_are_shown_when_either_side_lacks_data(self):
        result = experiment.compare([_row()], [])
        text = experiment.format_report("wifi", "ethernet", result)
        self.assertNotIn("median", text)

    def test_both_sides_with_data_show_a_line_per_layer(self):
        a = [_row(gw_ms=10.0)]
        b = [_row(gw_ms=20.0)]
        text = experiment.format_report("wifi", "ethernet", experiment.compare(a, b))
        for layer in experiment.LAYERS:
            self.assertIn(layer, text)


if __name__ == "__main__":
    unittest.main()
