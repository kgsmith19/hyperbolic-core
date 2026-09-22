"""SearXNG-Compatible Local Meta-Search HTTP Server.

Provides a lightweight, 100% free, local meta-search aggregator querying
DuckDuckGo and Bing with TLS impersonation (curl_cffi Chrome 124).
Exposes the standard SearXNG JSON API format at http://127.0.0.1:8080/search.
"""

from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import logging
import socket
from socketserver import ThreadingMixIn
import threading
import urllib.parse
from backend.meta_search.meta_search_aggregator import aggregate_meta_search

logger = logging.getLogger("searxng_service")


class SearXNGRequestHandler(BaseHTTPRequestHandler):
    """HTTP Request Handler providing standard SearXNG JSON API endpoints."""

    def log_message(self, format, *args):
        # Silence default stderr logging
        pass

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path in ("", "/"):
            # Health check / status page
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            payload = {
                "status": "ok",
                "service": "SearXNG-Compatible Local Engine",
                "version": "1.0.0",
                "engines": ["duckduckgo", "bing"],
            }
            self.wfile.write(json.dumps(payload).encode("utf-8"))
            return

        if path == "/search":
            qs = urllib.parse.parse_qs(parsed.query)
            query = qs.get("q", [""])[0]

            if not query.strip():
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"query": "", "results": []}).encode("utf-8"))
                return

            results = aggregate_meta_search(query, max_results=20)
            searxng_payload = {
                "query": query,
                "number_of_results": len(results),
                "results": results,
                "answers": [],
                "corrections": [],
                "infoboxes": [],
                "suggestions": [],
                "unresponsive_engines": [],
            }

            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(searxng_payload).encode("utf-8"))
            return

        self.send_response(404)
        self.end_headers()


class ThreadedSearXNGServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def is_port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    """Check if a TCP port is currently bound."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        try:
            s.connect((host, port))
            return True
        except (ConnectionRefusedError, socket.timeout, OSError):
            return False


def start_searxng_service(host: str = "127.0.0.1", port: int = 8080) -> ThreadedSearXNGServer | None:
    """Start local SearXNG service in background daemon thread if port is free."""
    if is_port_in_use(port, host):
        logger.info(f"Port {port} already active. SearXNG endpoint is ready.")
        return None

    try:
        server = ThreadedSearXNGServer((host, port), SearXNGRequestHandler)
        t = threading.Thread(target=server.serve_forever, daemon=True, name="SearXNG-Server")
        t.start()
        logger.info(f"SearXNG local meta-search service active on http://{host}:{port}")
        return server
    except Exception as e:
        logger.warning(f"Could not bind SearXNG service to {host}:{port}: {e}")
        return None
