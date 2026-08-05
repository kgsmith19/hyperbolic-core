"""Environment scan: everything measurable about this machine's network stack.

The load-bearing behaviour here is the unavailable/fail split. Sections that
need credentials must go quiet, not loud, when they have none.
"""
import unittest

from netcheck import diagnose, environ


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
