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

from network_checker import server, store

FRONTEND_FILES = list(server.FRONTEND.rglob("*"))
TEXT_SUFFIXES = {".html", ".css", ".js", ".webmanifest"}


def _text_assets():
    for path in FRONTEND_FILES:
        if path.is_file() and path.suffix in TEXT_SUFFIXES:
            yield path, path.read_text(encoding="utf-8")


# XML/SVG namespace identifiers: inert strings the platform requires for
# createElementNS, never a fetched resource. Everything else that looks like
# a URL is exactly what this test exists to catch.
_INERT_URIS = {"http://www.w3.org/2000/svg", "http://www.w3.org/1999/xhtml"}


class OfflineAssetTest(unittest.TestCase):
    def test_frontend_references_no_remote_assets(self):
        """A CDN link would work perfectly on every day except the one that
        matters, and would fail silently. Assert it, do not trust it."""
        for path, text in _text_assets():
            found = re.findall(r"""["'(]https?://[^"')\s]+""", text)
            remote = [u for u in found if u.lstrip("\"'(") not in _INERT_URIS]
            self.assertEqual(remote, [], f"remote assets in {path}: {remote}")

    def test_no_vendored_or_installed_third_party_code(self):
        """Stdlib-only, zero dependencies, no build step (AGENTS.md). Nothing
        under frontend/ may be a package manager's output or a vendored
        third-party library -- everything here is hand-written."""
        banned_names = {"node_modules", "package.json", "package-lock.json", "vendor"}
        found = {p.name for p in FRONTEND_FILES} & banned_names
        self.assertEqual(found, set(), f"found dependency/build artifacts: {found}")

    def test_export_and_drilldown_controls_are_present(self):
        """Export buttons and the click-to-see-evidence drill-down must
        actually be wired into the frontend, not just planned."""
        combined = "\n".join(text for _, text in _text_assets())
        for needle in ("exportJson", "exportCsv", "evidenceTable",
                       "s.culprit === cause", "gw_loss"):
            self.assertIn(needle, combined, f"missing dashboard control: {needle}")

    def test_scroll_containers_have_a_shadow_hint(self):
        """A table wider than its card gave no visual sign there was more to
        scroll to. Verified in a real browser (Playwright) that the shadow
        appears/disappears at the correct scroll position; this is the
        lightweight regression check that it stays wired into the CSS."""
        css = (server.FRONTEND / "css" / "components.css").read_text(encoding="utf-8")
        self.assertIn(".scroll {", css)
        self.assertIn("linear-gradient(to right, var(--surface) 30%, transparent) local", css)

    def test_service_worker_never_intercepts_the_live_stream(self):
        """A cached/replayed SSE response would freeze the dashboard on
        stale data forever -- the one route the service worker must ignore."""
        sw = (server.FRONTEND / "sw.js").read_text(encoding="utf-8")
        self.assertIn('"/api/stream"', sw)

    def test_sse_failure_switches_to_the_polling_fallback(self):
        """EventSource reports ordinary outages as CONNECTING, not CLOSED;
        the fallback must not wait for a state the browser never reaches."""
        api = (server.FRONTEND / "js" / "api.js").read_text(encoding="utf-8")
        error_handler = api.split("es.onerror =", 1)[1].split("};", 1)[0]
        self.assertIn("startPolling();", error_handler)
        self.assertNotIn("EventSource.CLOSED", error_handler)


class ServerIsolationTest(unittest.TestCase):
    def test_each_server_owns_its_sse_stop_event(self):
        """Restarting the dashboard must not let an older server shutdown
        terminate the replacement server's live stream."""
        conn = store.open_db(":memory:")
        first = server.serve(conn, port=0)
        second = server.serve(conn, port=0)
        first_thread = threading.Thread(target=first.serve_forever, daemon=True)
        second_thread = threading.Thread(target=second.serve_forever, daemon=True)
        first_thread.start()
        second_thread.start()
        try:
            first_event = first.RequestHandlerClass.stop_event
            second_event = second.RequestHandlerClass.stop_event
            self.assertIsNot(first_event, second_event)
            first.shutdown()
            self.assertTrue(first_event.is_set())
            self.assertFalse(second_event.is_set())
        finally:
            if first_thread.is_alive():
                first.shutdown()
            second.shutdown()
            first.server_close()
            second.server_close()
            conn.close()


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

    def get(self, path, **kw):
        with urllib.request.urlopen(self.base + path, timeout=5, **kw) as r:
            return r.status, r.read(), dict(r.headers)

    def test_index_serves_the_dashboard(self):
        status, body, headers = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn(b"network-checker", body)
        self.assertIn("text/html", headers["Content-Type"])

    def test_static_assets_are_served_generically(self):
        """No hardcoded per-file route: anything under frontend/ is served
        by path, with a correct content type inferred from its extension."""
        for path, content_type_fragment in (
            ("/css/tokens.css", "text/css"),
            ("/js/app.js", "javascript"),
            ("/manifest.webmanifest", "application/manifest+json"),
            ("/sw.js", "javascript"),
        ):
            status, body, headers = self.get(path)
            self.assertEqual(status, 200, path)
            self.assertIn(content_type_fragment, headers["Content-Type"], path)
            self.assertTrue(body, f"{path} served empty body")

    def test_static_route_cannot_escape_the_frontend_directory(self):
        with self.assertRaises(urllib.error.HTTPError) as cm:
            self.get("/../network_checker/server.py")
        self.assertEqual(cm.exception.code, 404)

    def test_data_route_returns_everything_the_page_needs(self):
        """Criterion 13: data exists and is correct, not just keys present."""
        status, body, _ = self.get("/api/data")
        self.assertEqual(status, 200)
        data = json.loads(body)

        for key in ("samples", "errors", "causes", "bursts", "scan", "live"):
            self.assertIn(key, data, f"missing key: {key}")

        self.assertEqual(len(data["samples"]), 1, "sample not in data")
        self.assertEqual(data["samples"][0]["culprit"], "internet",
                        "culprit not propagated to samples")
        self.assertEqual(len(data["errors"]), 1, "error not in data")
        self.assertEqual(data["errors"][0]["verdict"], "internet",
                        "error not correlated with sample")

    def test_stored_error_is_correlated_against_the_stored_sample(self):
        """End to end: an error 30s after a failing sample inherits its verdict."""
        _, body, _ = self.get("/api/data")
        errors = json.loads(body)["errors"]
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["verdict"], "internet")

    def test_stream_route_pushes_the_first_payload_immediately(self):
        """The SSE endpoint must not make a fresh browser tab wait out a
        polling interval for its first paint."""
        with urllib.request.urlopen(self.base + "/api/stream", timeout=5) as r:
            self.assertIn("text/event-stream", r.headers["Content-Type"])
            event_line = r.readline().decode()
            data_line = r.readline().decode()
        self.assertEqual(event_line.strip(), "event: data")
        self.assertTrue(data_line.startswith("data: "))
        payload = json.loads(data_line[len("data: "):])
        self.assertEqual(len(payload["samples"]), 1)

    def test_unknown_route_is_404(self):
        with self.assertRaises(urllib.error.HTTPError) as cm:
            self.get("/nope")
        self.assertEqual(cm.exception.code, 404)

    def test_unknown_api_route_is_404_not_a_static_file_lookup(self):
        with self.assertRaises(urllib.error.HTTPError) as cm:
            self.get("/api/nope")
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
