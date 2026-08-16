"""Dashboard server: stdlib HTTP, JSON API, an SSE push channel, static files.

Bound to localhost only. This serves an unauthenticated view of the machine's
network posture, which is fine on the loopback interface and would not be fine
anywhere else.
"""
import json
import mimetypes
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import diagnose, rank, store

# network_checker/ -> backend/ -> the app root, where frontend/ sits beside it.
FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
INDEX = FRONTEND / "index.html"

# SSE polls the DB for changes on a short tick; no push mechanism exists in
# SQLite itself, so this compares a cheap fingerprint instead of re-running
# the full correlate/rank pipeline every tick.
_STREAM_POLL_SECONDS = 1.0
_STREAM_HEARTBEAT_TICKS = 15

# mimetypes has no opinion on these; the frontend needs both served correctly.
_EXTRA_TYPES = {".webmanifest": "application/manifest+json", ".mjs": "application/javascript"}
_TEXTUAL_TYPES = ("application/javascript", "application/json", "application/manifest+json")


def _content_type(path):
    ctype = _EXTRA_TYPES.get(path.suffix) or mimetypes.guess_type(path.name)[0]
    if not ctype:
        return "application/octet-stream"
    return f"{ctype}; charset=utf-8" if ctype.startswith("text/") or ctype in _TEXTUAL_TYPES else ctype


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
        "causes": rank.rank(samples, errors, latest),
        "scan": latest,
        "live": dict(samples[0], culprit=diagnose.culprit(samples[0])) if samples else None,
    }


def _fingerprint(conn):
    """Cheapest possible "did anything change" check: the latest row id in
    each table that feeds `payload()`. All three are indexed primary keys."""
    row = conn.execute(
        "SELECT (SELECT MAX(id) FROM samples),"
        " (SELECT MAX(id) FROM llm_errors),"
        " (SELECT MAX(id) FROM env_scans)").fetchone()
    return tuple(row)


class Handler(BaseHTTPRequestHandler):
    db = None                       # set by serve()
    stop_event = threading.Event()  # set by serve(); shared across requests

    def log_message(self, *_):      # keep the console for the watcher's output
        pass

    def _send(self, body, ctype, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_static(self, rel_path):
        """Serve one file under FRONTEND, refusing to escape it."""
        target = (FRONTEND / rel_path).resolve()
        if FRONTEND not in target.parents or not target.is_file():
            return self._send(b"not found", "text/plain", 404)
        self._send(target.read_bytes(), _content_type(target))

    def _send_data(self, query):
        try:
            limit = int(parse_qs(query).get("limit", ["500"])[0])
        except (ValueError, TypeError):
            return self._send(b"invalid limit parameter", "text/plain", 400)
        # SQLite's `LIMIT -1` means "no limit at all" -- forwarding a
        # negative value straight through would silently bypass the 5000
        # cap below instead of being bounded by it.
        if limit < 0:
            return self._send(b"invalid limit parameter", "text/plain", 400)
        body = json.dumps(payload(self.db, min(limit, 5000)), default=str).encode()
        self._send(body, "application/json")

    def _stream_sse(self):
        """Push a fresh payload whenever the DB changes; otherwise a comment
        every ~15s keeps the connection alive through any intermediary.

        `db`/`stop_event` are snapshotted once: both live on the class and
        `serve()` may be called again (a fresh db, a fresh event) while this
        loop is still running out an earlier connection, and it must keep
        answering to the event it actually started under.
        """
        db, stop_event = self.db, self.stop_event
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        last, idle = None, 0
        try:
            while not stop_event.is_set():
                last, idle = self._sse_tick(db, last, idle)
                stop_event.wait(_STREAM_POLL_SECONDS)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # client went away; nothing more to do

    def _sse_tick(self, db, last, idle):
        """One poll: push a changed payload, or count toward a heartbeat.
        Returns the (last, idle) pair for the next tick."""
        current = _fingerprint(db)
        if current == last:
            idle += 1
            if idle >= _STREAM_HEARTBEAT_TICKS:
                self.wfile.write(b": keep-alive\n\n")
                self.wfile.flush()
                idle = 0
            return last, idle

        body = json.dumps(payload(db), default=str)
        self.wfile.write(f"event: data\ndata: {body}\n\n".encode())
        self.wfile.flush()
        return current, 0

    def do_GET(self):
        route = urlparse(self.path)
        if route.path in ("/", "/index.html"):
            return self._send(INDEX.read_bytes(), "text/html; charset=utf-8")
        if route.path == "/api/data":
            return self._send_data(route.query)
        if route.path == "/api/stream":
            return self._stream_sse()
        if not route.path.startswith("/api/"):
            return self._send_static(route.path.lstrip("/"))
        self._send(b"not found", "text/plain", 404)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def shutdown(self):
        self.RequestHandlerClass.stop_event.set()
        super().shutdown()


def serve(conn, port=8787):
    # A handler subclass binds state to this server instance. Reusing Handler
    # itself would let a later serve() replace the database and stop event for
    # every older server that still has an SSE request in flight.
    class BoundHandler(Handler):
        pass

    BoundHandler.db = conn
    BoundHandler.stop_event = threading.Event()
    return Server(("127.0.0.1", port), BoundHandler)
