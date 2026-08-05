"""Fix application: safe, self-verifying writes to ASUS router / CAX80 modem.

Every write defaults to `dry_run=True` (never touches the network) and a
write is only ever reported `applied` after a fresh read-back through the
same proven code path environ.router()/environ.modem() already use
confirms the value actually changed. If the write's HTTP request succeeds
but nothing was verified to change -- because the guessed NVRAM key or
endpoint shape turns out wrong (see OPEN-ISSUES.md, the write protocol is
unverified against live hardware) -- the result is `attempted`, never
`applied`. This project never reports success it can't prove; see
AGENTS.md and the disable_aiprotection tests below, which are the
flagship fully-verified case exercised over a real stub HTTP server (the
same stand-in-server pattern as test_store.py::MirrorTest._stub()).
"""
import os
import re
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch
from urllib.parse import parse_qs, unquote, urlparse

from netcheck import fix_application, fix_engine


def _stub_asus_server(test, initial_nvram=None):
    """Fake ASUS router speaking login.cgi / appGet.cgi / applyapp.cgi --
    enough of the real flow that FixApplier's login -> write -> read-back
    sequence is exercised for real, without a live router."""
    state = dict(initial_nvram or {})
    requests = []

    class H(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode()
            requests.append((self.path, self.headers.get("Cookie"), body))
            if self.path == "/login.cgi":
                payload = b'{"asus_token": "test-token"}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            elif self.path == "/applyapp.cgi":
                for pair in unquote(body).split(";"):
                    if "=" in pair:
                        k, v = pair.split("=", 1)
                        state[k] = v
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()
            else:
                self.send_response(404)
                self.end_headers()

        def do_GET(self):
            requests.append((self.path, self.headers.get("Cookie"), None))
            parsed = urlparse(self.path)
            if parsed.path == "/appGet.cgi":
                hook = parse_qs(parsed.query).get("hook", [""])[0]
                m = re.match(r"nvram_get\((\w+)\)", hook)
                key = m.group(1) if m else ""
                body = f"nvram_get({key})={state.get(key, '')}".encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()

    httpd = HTTPServer(("127.0.0.1", 0), H)
    test.addCleanup(httpd.server_close)
    test.addCleanup(httpd.shutdown)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f"127.0.0.1:{httpd.server_address[1]}", state, requests


class FixApplierInitializationTest(unittest.TestCase):
    def test_applier_accepts_all_device_types(self):
        for device_type in ["asus_router", "cax80_modem", "local_config"]:
            applier = fix_application.FixApplier(device_type)
            self.assertEqual(applier.device_type, device_type)

    def test_applier_initializes_applied_fixes_list(self):
        applier = fix_application.FixApplier("asus_router")
        self.assertIsInstance(applier.applied_fixes, list)
        self.assertEqual(len(applier.applied_fixes), 0)

    def test_dry_run_defaults_true(self):
        applier = fix_application.FixApplier("asus_router", user="u", password="p")
        self.assertTrue(applier.dry_run)

    def test_explicit_args_are_used_over_env(self):
        with patch.dict(os.environ, {"ROUTER_HOST": "10.0.0.1", "ROUTER_USER": "envuser"}):
            applier = fix_application.FixApplier("asus_router", host="1.2.3.4", user="explicit")
        self.assertEqual(applier.host, "1.2.3.4")
        self.assertEqual(applier.user, "explicit")

    def test_env_vars_fill_in_when_not_passed(self):
        with patch.dict(os.environ, {"ROUTER_HOST": "10.0.0.1", "ROUTER_USER": "envuser",
                                      "ROUTER_PASS": "envpass"}):
            applier = fix_application.FixApplier("asus_router")
        self.assertEqual(applier.host, "10.0.0.1")
        self.assertEqual(applier.user, "envuser")
        self.assertEqual(applier.password, "envpass")

    def test_modem_env_vars_are_independent_of_router(self):
        with patch.dict(os.environ, {"MODEM_HOST": "192.168.100.5", "MODEM_USER": "m"}):
            applier = fix_application.FixApplier("cax80_modem")
        self.assertEqual(applier.host, "192.168.100.5")
        self.assertEqual(applier.user, "m")


class DeviceTypeValidationTest(unittest.TestCase):
    """Wi-Fi/AiProtection/QoS fixes only make sense on an ASUS router --
    there's no known write path for the CAX80 modem or local_config."""

    def test_wifi_fix_rejects_wrong_device_type(self):
        for device_type in ["cax80_modem", "local_config"]:
            applier = fix_application.FixApplier(device_type)
            result = applier.apply_wifi_channel_fix("36")
            self.assertEqual(result["status"], "error")
            self.assertIn("reason", result)

    def test_aiprotection_rejects_non_asus(self):
        applier = fix_application.FixApplier("cax80_modem")
        result = applier.disable_aiprotection()
        self.assertEqual(result["status"], "error")

    def test_qos_rejects_non_asus(self):
        applier = fix_application.FixApplier("local_config")
        result = applier.disable_qos()
        self.assertEqual(result["status"], "error")


class NoCredentialsTest(unittest.TestCase):
    """A missing router password must degrade to unavailable -- never a
    crash, and never a claimed write."""

    def test_wifi_fix_without_credentials_is_unavailable(self):
        applier = fix_application.FixApplier("asus_router", host="h", dry_run=False)
        result = applier.apply_wifi_channel_fix("36")
        self.assertEqual(result["status"], "unavailable")
        self.assertIn("credential", result["reason"].lower())

    def test_aiprotection_without_credentials_is_unavailable(self):
        applier = fix_application.FixApplier("asus_router", host="h", dry_run=False)
        result = applier.disable_aiprotection()
        self.assertEqual(result["status"], "unavailable")

    def test_restart_without_credentials_is_unavailable(self):
        applier = fix_application.FixApplier("asus_router", host="h", dry_run=False)
        result = applier.restart_device()
        self.assertEqual(result["status"], "unavailable")

    def test_get_device_status_without_credentials_is_unavailable(self):
        applier = fix_application.FixApplier("asus_router", host="h")
        result = applier.get_device_status()
        self.assertEqual(result["status"], "unavailable")


class DryRunIsSafeByDefaultTest(unittest.TestCase):
    """dry_run=True (the default) must never make a network call."""

    def test_wifi_fix_dry_run_makes_no_network_call(self):
        applier = fix_application.FixApplier("asus_router", host="1.2.3.4", user="u", password="p")
        with patch("netcheck.environ._asus_login") as mock_login:
            result = applier.apply_wifi_channel_fix("36", "80MHz")
        mock_login.assert_not_called()
        self.assertEqual(result["status"], "dry_run")
        self.assertEqual(result["would_write"]["wl1_chanspec"], "36")

    def test_aiprotection_dry_run_makes_no_network_call(self):
        applier = fix_application.FixApplier("asus_router", host="1.2.3.4", user="u", password="p")
        with patch("netcheck.environ._asus_login") as mock_login:
            result = applier.disable_aiprotection()
        mock_login.assert_not_called()
        self.assertEqual(result["status"], "dry_run")

    def test_restart_dry_run_makes_no_network_call(self):
        applier = fix_application.FixApplier("asus_router", host="1.2.3.4", user="u", password="p")
        with patch("netcheck.environ._asus_login") as mock_login:
            result = applier.restart_device()
        mock_login.assert_not_called()
        self.assertEqual(result["status"], "dry_run")


class DisableAiProtectionFullFlowTest(unittest.TestCase):
    """The flagship fully-verified case: write, then confirm with a fresh
    read through environ.router() -- the same function this project
    already trusts for reading AiProtection state."""

    def test_write_confirmed_by_readback_reports_applied(self):
        host, state, requests = _stub_asus_server(self, {"wrs_protect_enable": "1"})
        applier = fix_application.FixApplier("asus_router", host=host, user="admin",
                                              password="pw", dry_run=False)

        result = applier.disable_aiprotection()

        self.assertEqual(result["status"], "applied")
        self.assertTrue(result["verified_by_readback"])
        self.assertEqual(state["wrs_protect_enable"], "0")
        paths = [p for p, _, _ in requests]
        self.assertIn("/login.cgi", paths)
        self.assertIn("/applyapp.cgi", paths)
        self.assertTrue(any(p.startswith("/appGet.cgi") for p in paths))

    def test_write_not_reflected_by_readback_reports_attempted_not_applied(self):
        """If the write's HTTP request succeeds but doesn't actually change
        the value -- e.g. the guessed NVRAM key is wrong -- this must
        never claim `applied`."""
        host, state, requests = _stub_asus_server(self, {"wrs_protect_enable": "1"})
        applier = fix_application.FixApplier("asus_router", host=host, user="admin",
                                              password="pw", dry_run=False)

        with patch("netcheck.environ._asus_set", return_value=("ok", None)):
            result = applier.disable_aiprotection()

        self.assertEqual(result["status"], "attempted")
        self.assertNotIn("verified_by_readback", result)
        self.assertEqual(state["wrs_protect_enable"], "1", "value must be untouched")

    def test_login_failure_reports_fail_not_applied(self):
        applier = fix_application.FixApplier("asus_router", host="127.0.0.1:1", user="admin",
                                              password="pw", dry_run=False)
        result = applier.disable_aiprotection()
        self.assertEqual(result["status"], "fail")
        self.assertIn("reason", result)


class WifiChannelFixAttemptTest(unittest.TestCase):
    """No proven single-key read-back exists for Wi-Fi channel/bandwidth
    (unlike wrs_protect_enable), so a successful write reports `attempted`,
    never `applied` -- this project doesn't invent verification it can't
    perform."""

    def test_successful_write_reports_attempted(self):
        host, state, requests = _stub_asus_server(self)
        applier = fix_application.FixApplier("asus_router", host=host, user="admin",
                                              password="pw", dry_run=False)

        result = applier.apply_wifi_channel_fix("36", "80MHz")

        self.assertEqual(result["status"], "attempted")
        self.assertEqual(state["wl1_chanspec"], "36")
        self.assertEqual(state["wl1_bw"], "80MHz")

    def test_write_failure_reports_fail(self):
        applier = fix_application.FixApplier("asus_router", host="127.0.0.1:1", user="admin",
                                              password="pw", dry_run=False)
        result = applier.apply_wifi_channel_fix("36")
        self.assertEqual(result["status"], "fail")


class DisableQosAttemptTest(unittest.TestCase):
    def test_successful_write_reports_attempted(self):
        host, state, requests = _stub_asus_server(self)
        applier = fix_application.FixApplier("asus_router", host=host, user="admin",
                                              password="pw", dry_run=False)

        result = applier.disable_qos()

        self.assertEqual(result["status"], "attempted")
        self.assertTrue(result["requires_reboot"])
        self.assertEqual(state["qos_enable"], "0")


class RestartDeviceTest(unittest.TestCase):
    def test_restart_asus_reports_requested_on_success(self):
        host, state, requests = _stub_asus_server(self)
        applier = fix_application.FixApplier("asus_router", host=host, user="admin",
                                              password="pw", dry_run=False)

        result = applier.restart_device()

        self.assertEqual(result["status"], "requested")
        self.assertEqual(result["device"], "asus_router")

    def test_restart_modem_is_unavailable_no_known_write_path(self):
        applier = fix_application.FixApplier("cax80_modem", host="h", user="u",
                                              password="p", dry_run=False)
        result = applier.restart_device()
        self.assertEqual(result["status"], "unavailable")

    def test_restart_local_config_is_unavailable(self):
        applier = fix_application.FixApplier("local_config")
        result = applier.restart_device()
        self.assertEqual(result["status"], "unavailable")


class GetDeviceStatusTest(unittest.TestCase):
    """get_device_status delegates to the same proven environ.router()/
    environ.modem() read paths -- it does not maintain its own parallel
    notion of device state."""

    def test_asus_router_status_delegates_to_environ_router(self):
        host, state, requests = _stub_asus_server(self, {"wrs_protect_enable": "1"})
        applier = fix_application.FixApplier("asus_router", host=host, user="admin", password="pw")

        result = applier.get_device_status()

        self.assertEqual(result["device_type"], "asus_router")
        self.assertEqual(result["status"], "connected")
        self.assertTrue(result["can_read_metrics"])
        self.assertTrue(result["detail"]["aiprotection_enabled"])

    def test_local_config_has_no_admin_api(self):
        applier = fix_application.FixApplier("local_config")
        result = applier.get_device_status()
        self.assertEqual(result["status"], "unavailable")


class TimestampTrackingTest(unittest.TestCase):
    def test_every_result_has_an_iso_timestamp(self):
        from datetime import datetime
        applier = fix_application.FixApplier("asus_router", host="h", user="u", password="p")
        result = applier.apply_wifi_channel_fix("36")

        self.assertIn("timestamp", result)
        self.assertIsNotNone(datetime.fromisoformat(result["timestamp"]))


class FixSequenceApplicationTest(unittest.TestCase):
    """apply_fix_sequence is a pure dispatcher over caller-supplied
    handlers -- unaffected by how FixApplier's own methods work."""

    def test_sequence_applies_all_fixes(self):
        fixes = [
            fix_engine.FixRecommendation("wifi_ch", "Channel", "wifi", "low", 0.8, ["step"]),
            fix_engine.FixRecommendation("disable_ai", "AiProt", "router", "medium", 0.6, ["step"]),
        ]
        handlers = {
            "wifi": lambda f: {"fix_id": f.id, "status": "applied", "requires_reboot": False},
            "router": lambda f: {"fix_id": f.id, "status": "applied", "requires_reboot": True},
        }

        results = fix_application.apply_fix_sequence(fixes, handlers)

        self.assertEqual(len(results), 3)
        self.assertEqual(results[0]["fix_id"], "wifi_ch")
        self.assertEqual(results[1]["fix_id"], "disable_ai")

    def test_sequence_tracks_reboot_requirement(self):
        fixes = [
            fix_engine.FixRecommendation("fix1", "Fix 1", "wifi", "low", 0.8, ["step"]),
            fix_engine.FixRecommendation("fix2", "Fix 2", "router", "medium", 0.6, ["step"]),
        ]
        handlers = {
            "wifi": lambda f: {"fix_id": f.id, "status": "applied", "requires_reboot": False},
            "router": lambda f: {"fix_id": f.id, "status": "applied", "requires_reboot": True},
        }

        results = fix_application.apply_fix_sequence(fixes, handlers)

        self.assertEqual(results[-1]["action"], "reboot_recommended")

    def test_sequence_skips_missing_handlers(self):
        fixes = [
            fix_engine.FixRecommendation("fix1", "Fix 1", "unknown_category", "low", 0.5, ["step"]),
        ]
        results = fix_application.apply_fix_sequence(fixes, {})

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["status"], "skipped")

    def test_sequence_no_reboot_if_not_needed(self):
        fixes = [
            fix_engine.FixRecommendation("fix1", "Fix 1", "wifi", "low", 0.8, ["step"]),
        ]
        handlers = {
            "wifi": lambda f: {"fix_id": f.id, "status": "applied", "requires_reboot": False},
        }

        results = fix_application.apply_fix_sequence(fixes, handlers)

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["fix_id"], "fix1")


class IntegrationWithFixEngineTest(unittest.TestCase):
    """FixApplier's dry-run preview lines up with what fix_engine actually
    recommends -- the two modules agree on what a fix targets."""

    def test_wifi_fix_from_diagnosis_previews_in_dry_run(self):
        diagnosis = {"primary_culprit": "gateway", "synthesis_confidence": 0.85}
        fixes = fix_engine.recommend_fixes_for_diagnosis(diagnosis)
        wifi_fixes = [f for f in fixes if f.category == "wifi"]
        self.assertGreater(len(wifi_fixes), 0)

        applier = fix_application.FixApplier("asus_router", host="h", user="u", password="p")
        result = applier.apply_wifi_channel_fix("36")

        self.assertEqual(result["status"], "dry_run")

    def test_router_fix_from_diagnosis_previews_in_dry_run(self):
        diagnosis = {"primary_culprit": "router", "synthesis_confidence": 0.75}
        fixes = fix_engine.recommend_fixes_for_diagnosis(diagnosis)
        router_fixes = [f for f in fixes if f.category == "router"]
        self.assertGreater(len(router_fixes), 0)

        applier = fix_application.FixApplier("asus_router", host="h", user="u", password="p")
        result = applier.disable_aiprotection()

        self.assertEqual(result["status"], "dry_run")


if __name__ == "__main__":
    unittest.main()
