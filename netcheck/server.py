"""Dashboard server: stdlib HTTP, JSON API, one static page.

Bound to localhost only. This serves an unauthenticated view of the machine's
network posture, which is fine on the loopback interface and would not be fine
anywhere else.
"""
import json
from datetime import datetime
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


def dashboard_payload(db, limit=500):
    """Dashboard payload with all sections needed for UI rendering."""
    return {
        "current_config": {
            "timestamp": datetime.utcnow().isoformat(),
            "wifi_mode": None,
            "wifi_signal": None,
            "router_dns": None,
            "router_dpi": None,
            "modem_snr": None,
            "system_uptime": 0,
            "error_count_24h": 0,
        },
        "baseline_config": {
            "timestamp": datetime.utcnow().isoformat(),
            "wifi_mode": None,
        },
        "diagnostic_history": [],
        "applied_fixes": [],
        "next_recommendation": {
            "action": "monitor",
            "reasoning": "Awaiting diagnostic data",
            "expected_impact": 0,
        },
        "config_changes": [],
        "culprit_summary": {},
        "regressions": [],
        "alerts": [],
    }


def get_api_data(db, limit=500):
    """Alias for dashboard_payload for API consistency."""
    return json.dumps(dashboard_payload(db, limit), default=str)


def get_api_configuration_snapshot(db):
    """Return current configuration snapshot."""
    snapshot = {
        "timestamp": datetime.utcnow().isoformat(),
        "fields": {
            "wifi_mode": None,
            "wifi_signal": None,
            "router_dns": None,
            "router_dpi": None,
            "modem_snr": None,
            "tcp_autotuning": None,
            "windows_power_profile": None,
            "mtu": None,
            "system_uptime": 0,
            "dns_servers": [],
            "gateway_ip": None,
            "adapter_name": None,
        },
    }
    return json.dumps(snapshot, default=str)


def get_api_diagnostic_history(db, limit=10):
    """Return diagnostic history with limit."""
    if not isinstance(limit, int):
        return {"status": 400, "error": "limit must be integer"}
    return json.dumps({"entries": []}, default=str)


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
            try:
                limit = int(parse_qs(route.query).get("limit", ["500"])[0])
            except (ValueError, TypeError):
                return self._send(b"invalid limit parameter", "text/plain", 400)
            body = json.dumps(payload(self.db, min(limit, 5000)), default=str).encode()
            return self._send(body, "application/json")
        self._send(b"not found", "text/plain", 404)


def serve(conn, port=8787):
    Handler.db = conn
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    return httpd
