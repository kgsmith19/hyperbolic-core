"""Dashboard server: stdlib HTTP, JSON API, one static page.

Bound to localhost only. This serves an unauthenticated view of the machine's
network posture, which is fine on the loopback interface and would not be fine
anywhere else.
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import diagnose, store

UI = Path(__file__).with_name("ui.html")
VENDOR = Path(__file__).parent / "vendor"


def payload(conn, limit=500):
    """Everything the dashboard renders, in one round trip."""
    samples = store.samples(conn, limit)
    raw = store.errors(conn, 500)
    scans = store.scans(conn, 1)
    latest = json.loads(scans[0]["payload"]) if scans else {}
    errors = diagnose.correlate(raw, samples)
    return {
        "samples": samples,
        "errors": errors,
        "bursts": diagnose.bursts(raw) if raw else [],
        "causes": diagnose.rank(samples, errors, latest),
        "scan": latest,
        "live": dict(samples[0], culprit=diagnose.culprit(samples[0])) if samples else None,
    }


class Handler(BaseHTTPRequestHandler):
    db = None                       # set by serve()

    def log_message(self, *_):      # keep the console for the watcher's output
        pass

    def _send(self, body, ctype, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = urlparse(self.path)
        if route.path in ("/", "/index.html"):
            return self._send(UI.read_bytes(), "text/html; charset=utf-8")
        if route.path == "/vendor/alpine.min.js":
            return self._send((VENDOR / "alpine.min.js").read_bytes(),
                              "text/javascript; charset=utf-8")
        if route.path == "/api/data":
            limit = int(parse_qs(route.query).get("limit", ["500"])[0])
            body = json.dumps(payload(self.db, min(limit, 5000)), default=str).encode()
            return self._send(body, "application/json")
        self._send(b"not found", "text/plain", 404)


def serve(conn, port=8787):
    Handler.db = conn
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    return httpd
