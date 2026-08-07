"""Dashboard server.

Criterion 13: it renders from stored data with no network access at all, which
is the only condition that matters — the dashboard exists to be read during an
outage.
"""
import json
import re
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from netcheck import server, store


class OfflineAssetTest(unittest.TestCase):
    def test_ui_references_no_remote_assets(self):
        """A CDN link would work perfectly on every day except the one that
        matters, and would fail silently. Assert it, do not trust it."""
        html = server.UI.read_text(encoding="utf-8")
        remote = re.findall(r"""["'(]https?://[^"')\s]+""", html)
        self.assertEqual(remote, [], f"remote assets in ui.html: {remote}")

    def test_vendored_alpine_is_present(self):
        alpine = server.VENDOR / "alpine.min.js"
        self.assertTrue(alpine.exists(), "Alpine must be vendored, not fetched")
        self.assertGreater(alpine.stat().st_size, 10_000)

    def test_export_and_drilldown_controls_are_present(self):
        """Phase 27: export buttons and the click-to-see-evidence drill-down
        must actually be wired into the page, not just planned."""
        html = server.UI.read_text(encoding="utf-8")
        for needle in ("exportJson()", "exportCsv()", "toggleEvidence(",
                       "matchingSamples(", "lossChart"):
            self.assertIn(needle, html, f"missing dashboard control: {needle}")

    def test_scroll_containers_have_a_shadow_hint(self):
        """A table wider than its card gave no visual sign there was more
        to scroll to. Verified in a real browser
        (Playwright) that the shadow appears/disappears at the correct
        scroll position; this is the lightweight regression check that it
        stays wired into the CSS."""
        html = server.UI.read_text(encoding="utf-8")
        self.assertIn(".scroll {", html)
        self.assertIn("linear-gradient(to right, var(--surface) 30%, transparent) local", html)
        self.assertIn("background-size: 24px 100%, 24px 100%, 8px 100%, 8px 100%;", html)


class ApiTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.conn = store.open_db(Path(self.dir.name) / "t.db")
        self.addCleanup(self.conn.close)
        host = store.host_id(self.conn, "test", "Windows")

        store.add_sample(self.conn, host, {
            "ts": "2026-08-05T00:00:00Z", "gw_state": "ok", "gw_ms": 2.0,
            "hop_state": "ok", "inet_state": "fail", "inet_loss": 100.0,
            "dns_router_state": "ok", "dns_public_state": "ok",
            "tls_state": "fail", "http_state": "fail", "culprit": "internet"})
        store.add_error(self.conn, host, {
            "ts": "2026-08-05T00:00:30Z", "source": "claude-code",
            "kind": "network", "detail": "API Error: ECONNRESET"})
        store.add_scan(self.conn, host, {
            "ts": "2026-08-05T00:00:00Z",
            "payload": json.dumps({"wifi": {"state": "ok", "ssid": "x", "channel": 44}})})

        self.httpd = server.serve(self.conn, port=0)
        self.addCleanup(self.httpd.server_close)   # LIFO: runs after shutdown
        self.addCleanup(self.httpd.shutdown)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=5) as r:
            return r.status, r.read()

    def test_index_serves_the_dashboard(self):
        status, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn(b"netcheck", body)

    def test_vendor_route_serves_alpine(self):
        status, body = self.get("/vendor/alpine.min.js")
        self.assertEqual(status, 200)
        self.assertIn(b"Alpine", body)

    def test_data_route_returns_everything_the_page_needs(self):
        """Criterion 13: data exists and is correct, not just keys present."""
        status, body = self.get("/api/data")
        self.assertEqual(status, 200)
        data = json.loads(body)

        # Keys must exist
        for key in ("samples", "errors", "causes", "bursts", "scan", "live"):
            self.assertIn(key, data, f"missing key: {key}")

        # Data must be non-empty and correct
        self.assertEqual(len(data["samples"]), 1, "sample not in data")
        self.assertEqual(data["samples"][0]["culprit"], "internet",
                        "culprit not propagated to samples")
        self.assertEqual(len(data["errors"]), 1, "error not in data")
        self.assertEqual(data["errors"][0]["verdict"], "internet",
                        "error not correlated with sample")

    def test_stored_error_is_correlated_against_the_stored_sample(self):
        """End to end: an error 30s after a failing sample inherits its verdict."""
        _, body = self.get("/api/data")
        errors = json.loads(body)["errors"]
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["verdict"], "internet")

    def test_unknown_route_is_404(self):
        with self.assertRaises(urllib.error.HTTPError) as cm:
            self.get("/nope")
        self.assertEqual(cm.exception.code, 404)

    def test_invalid_limit_parameter_returns_400_not_crash(self):
        """Criterion 6: client input must not crash the server.
        Malformed limit parameter should return 400, not 500."""
        with self.assertRaises(urllib.error.HTTPError) as cm:
            self.get("/api/data?limit=abc")
        self.assertEqual(cm.exception.code, 400,
                        "malformed limit should be client error, not server crash")


if __name__ == "__main__":
    unittest.main()
