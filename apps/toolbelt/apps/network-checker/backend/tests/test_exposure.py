"""LAN exposure checks: bounded, read-only, LAN-only behavior (FR-019)."""
import unittest
from unittest.mock import patch

from network_checker import exposure


class ExposureScanTest(unittest.TestCase):
    def test_fixed_default_credential_list_is_bounded(self):
        self.assertLessEqual(len(exposure._DEFAULT_CREDENTIALS), 20)

    def test_open_port_and_default_credential_findings_are_named(self):
        mapped = {"state": "ok", "devices": [{"ip": "192.168.1.7", "mac": None, "name": "router"}]}
        with patch.object(exposure.remote, "_on_lan", return_value=True), \
             patch.object(exposure, "_check_open_ports", return_value=[80]), \
             patch.object(exposure, "_find_login_endpoint", return_value="/login"), \
             patch.object(exposure, "_credential_match", return_value="DC02"):
            got = exposure.scan(mapped)

        self.assertEqual(got["state"], "ok")
        findings = got["findings"]
        self.assertIn({"ip": "192.168.1.7", "name": "router", "kind": "open_port", "port": 80},
                      findings)
        self.assertIn({"ip": "192.168.1.7", "name": "router", "kind": "default_credential",
                       "entry": "DC02", "endpoint": "http://192.168.1.7/login"}, findings)

    def test_a_device_open_only_on_8080_is_probed_on_its_alternate_port(self):
        """Port 80 closed, 8080 open: the login/credential probe must target
        `host:8080`, not silently skip the device because 80 was the only
        port ever hardcoded."""
        mapped = {"state": "ok", "devices": [{"ip": "192.168.1.9", "mac": None, "name": None}]}
        with patch.object(exposure.remote, "_on_lan", return_value=True), \
             patch.object(exposure, "_check_open_ports", return_value=[8080]), \
             patch.object(exposure, "_find_login_endpoint", return_value="/login") as mock_find, \
             patch.object(exposure, "_credential_match", return_value="DC01") as mock_match:
            got = exposure.scan(mapped)

        mock_find.assert_called_once_with("192.168.1.9:8080")
        mock_match.assert_called_once_with("192.168.1.9:8080", "/login")
        self.assertIn({"ip": "192.168.1.9", "name": None, "kind": "default_credential",
                       "entry": "DC01", "endpoint": "http://192.168.1.9:8080/login"},
                      got["findings"])

    def test_off_lan_device_is_unavailable_and_no_connections_are_attempted(self):
        mapped = {"state": "ok", "devices": [{"ip": "8.8.8.8", "mac": None, "name": None}]}
        with patch.object(exposure.remote, "_on_lan", return_value=False), \
             patch.object(exposure.socket, "create_connection") as mock_connect, \
             patch.object(exposure.remote, "_fetch") as mock_fetch:
            got = exposure.scan(mapped)

        self.assertEqual(got["devices"][0]["state"], "unavailable")
        self.assertIn("_on_lan", got["devices"][0]["reason"])
        mock_connect.assert_not_called()
        mock_fetch.assert_not_called()

    def test_topology_unavailable_makes_exposure_unavailable(self):
        got = exposure.scan({"state": "unavailable", "reason": "arp -a unavailable"})
        self.assertEqual(got["state"], "unavailable")
        self.assertIn("arp -a unavailable", got["reason"])


class CredentialAttemptTest(unittest.TestCase):
    def test_credential_attempts_never_exceed_the_fixed_list(self):
        calls = []

        def fake_fetch(req, _timeout):
            calls.append(req)
            return None, "HTTP 401"

        with patch.object(exposure.remote, "_fetch", side_effect=fake_fetch):
            self.assertIsNone(exposure._credential_match("192.168.1.1", "/login"))

        self.assertEqual(len(calls), len(exposure._DEFAULT_CREDENTIALS))

    def test_credential_attempt_requests_are_get_only(self):
        methods = []
        payloads = []

        def fake_fetch(req, _timeout):
            methods.append(req.get_method())
            payloads.append(req.data)
            return "", None

        with patch.object(exposure.remote, "_fetch", side_effect=fake_fetch):
            self.assertEqual(exposure._credential_match("192.168.1.1", "/login"), "DC01")

        self.assertEqual(methods, ["GET"])
        self.assertEqual(payloads, [None])


if __name__ == "__main__":
    unittest.main()
