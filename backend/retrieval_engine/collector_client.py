"""Collector Client Managing Network-Isolated Subprocess.

Communicates with the child worker process over stdin/stdout pipes,
enforcing outbound safety assertions, ephemeral memory buffers, and inbound sanitization.
"""

import json
import os
import subprocess
import sys
from backend.security_guard.watchlist_redactor import redact, assert_safe_to_send, SafetyError
from backend.security_guard.encrypted_scratchpad import SecureZeroBuffer
from backend.security_guard.quarantine_zone import SanitizedQuarantine
from backend.discovery_frontier.url_canonicalizer import canonicalize_url
from backend.retrieval_engine.bot_barrier_detector import is_bot_or_js_barrier


class CollectorClient:
    """Client for the network-isolated Collector process with outbound safety guards."""

    def __init__(self):
        self.process = None
        self._start_process()

    def _start_process(self):
        """Start collector worker as an isolated child process over stdin/stdout."""
        pkg_dir = os.path.dirname(os.path.abspath(__file__))
        root_dir = os.path.dirname(os.path.dirname(pkg_dir))
        root_collector = os.path.join(root_dir, "collector.py")
        worker_collector = os.path.join(pkg_dir, "collector_worker.py")

        collector_script = root_collector if os.path.exists(root_collector) else worker_collector

        self.process = subprocess.Popen(
            [sys.executable, collector_script, "--ipc"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1
        )

    def close(self):
        """Terminate collector process and close communication pipes."""
        if self.process:
            try:
                if self.process.stdin:
                    self.process.stdin.close()
                if self.process.stdout:
                    self.process.stdout.close()
                if self.process.stderr:
                    self.process.stderr.close()
                self.process.terminate()
                self.process.wait(timeout=2)
            except Exception:
                pass
            self.process = None

    def send_task(self, task: dict, watchlist: list[str]) -> dict:
        """Send a retrieval task to the collector process through the outbound safety guard."""
        # OUTBOUND SAFETY GUARD: Verify task payload contains zero watchlist terms
        assert_safe_to_send(task, watchlist)

        if not self.process or self.process.poll() is not None:
            self._start_process()

        line = json.dumps(task)
        self.process.stdin.write(line + "\n")
        self.process.stdin.flush()

        resp_line = self.process.stdout.readline()
        if not resp_line:
            return {"status": "error", "error": "Collector process terminated unexpectedly."}

        # EPHEMERAL QUARANTINE: Load raw IPC bytes into zero-scrubbed buffer
        with SecureZeroBuffer(resp_line) as raw_buf:
            try:
                quarantined_payload = json.loads(raw_buf.read_text().strip())
            except Exception:
                return {"status": "error", "error": "Failed to decode response from collector."}

        # INBOUND QUARANTINE: Sanitize and redact every string before releasing into application state
        sanitized_payload = self._sanitize_quarantined_payload(quarantined_payload, watchlist)
        assert_safe_to_send(sanitized_payload, watchlist)
        return sanitized_payload

    def _sanitize_quarantined_payload(self, obj, watchlist: list[str]):
        """Recursively redact all text within quarantined collector payload and defang injections."""
        if isinstance(obj, str):
            cleaned = obj
            for pat in SanitizedQuarantine.INJECTION_PATTERNS:
                cleaned = pat.sub("[REDACTED:prompt-injection-attempt]", cleaned)
            return redact(cleaned, watchlist)
        elif isinstance(obj, list):
            return [self._sanitize_quarantined_payload(item, watchlist) for item in obj]
        elif isinstance(obj, dict):
            return {k: self._sanitize_quarantined_payload(v, watchlist) for k, v in obj.items()}
        return obj


# Global collector client instance
_COLLECTOR: CollectorClient | None = None


def get_collector() -> CollectorClient:
    """Get or initialize global CollectorClient."""
    global _COLLECTOR
    if _COLLECTOR is None:
        _COLLECTOR = CollectorClient()
    return _COLLECTOR


def reset_collector() -> None:
    """Close and reset global CollectorClient so subsequent tasks respawn fresh."""
    global _COLLECTOR
    if _COLLECTOR:
        try:
            _COLLECTOR.close()
        except Exception:
            pass
        _COLLECTOR = None


def search_brave(topic: str, watchlist: list[str]) -> list[dict]:
    """Search Brave API (via collector router) for public results."""
    assert_safe_to_send(topic, watchlist)
    collector = get_collector()
    task = {"task_id": "search-brave", "action": "search", "connector": "brave", "query": topic}
    resp = collector.send_task(task, watchlist)
    if resp.get("status") == "ok":
        return resp.get("results", [])
    return []


def fetch_html_text(url: str, watchlist: list[str]) -> str:
    """Fetch a webpage (via collector router) and extract clean plain text."""
    assert_safe_to_send(url, watchlist)
    collector = get_collector()
    task = {"task_id": "fetch-url", "action": "fetch", "url": url}
    resp = collector.send_task(task, watchlist)
    if resp.get("status") == "ok":
        return resp.get("content", "")
    return ""


def build_sanitized_evidence(results: list[dict], watchlist: list[str]) -> list[dict]:
    """Process search results, canonicalize URLs, fetch excerpts, and redact watchlist matches."""
    collector = get_collector()
    evidence_list = []
    seen_urls = set()

    for item in results:
        raw_url = item.get("url", "")
        canonical_url = canonicalize_url(raw_url)
        if not canonical_url or canonical_url in seen_urls:
            continue
        seen_urls.add(canonical_url)

        clean_url = redact(canonical_url, watchlist)
        clean_title = redact(item.get("title", ""), watchlist)
        clean_snippet = redact(item.get("snippet", ""), watchlist)

        excerpt = ""
        if len(evidence_list) < 5 and clean_url.startswith(("http://", "https://")):
            task = {"task_id": f"fetch-{len(evidence_list)}", "action": "fetch", "url": clean_url}
            fetch_res = collector.send_task(task, watchlist)
            if fetch_res.get("status") == "ok":
                raw_c = fetch_res.get("content", "")
                if not is_bot_or_js_barrier(raw_c):
                    excerpt = raw_c

        entry = {
            "title": clean_title,
            "url": clean_url,
            "snippet": clean_snippet,
            "excerpt": excerpt,
        }

        try:
            assert_safe_to_send(entry["title"], watchlist)
            assert_safe_to_send(entry["url"], watchlist)
            assert_safe_to_send(entry["snippet"], watchlist)
            assert_safe_to_send(entry["excerpt"], watchlist)
            evidence_list.append(entry)
        except SafetyError:
            continue

    return evidence_list
