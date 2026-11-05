"""Collector Client Managing Network-Isolated Subprocess.

Communicates with the child worker process over stdin/stdout pipes,
enforcing outbound safety assertions, ephemeral memory buffers, and inbound sanitization.
"""

import json
import os
import subprocess
import sys
import threading
from typing import Any
from backend.privacy.watchlist_redactor import redact, assert_safe_to_send
from backend.privacy.encrypted_scratchpad import SecureZeroBuffer
from backend.privacy.quarantine_zone import SanitizedQuarantine


class CollectorClient:
    """Client for the network-isolated Collector process with outbound safety guards."""

    def __init__(self):
        self.process = None
        self._io_lock = threading.Lock()
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

    def send_task(self, task: dict, watchlist: list[str]) -> Any:
        """Send a retrieval task to the collector process through the outbound safety guard."""
        # OUTBOUND SAFETY GUARD: Verify task payload contains zero watchlist terms
        assert_safe_to_send(task, watchlist)

        with self._io_lock:
            if not self.process or self.process.poll() is not None:
                self._start_process()

            process = self.process
            if process is None or process.stdin is None or process.stdout is None:
                return {"status": "error", "error": "Collector process terminated unexpectedly."}

            line = json.dumps(task)
            process.stdin.write(line + "\n")
            process.stdin.flush()

            resp_line = process.stdout.readline()
            if not resp_line:
                return {"status": "error", "error": "Collector process terminated unexpectedly."}

        # EPHEMERAL QUARANTINE: Load raw IPC bytes into zero-scrubbed buffer
        with SecureZeroBuffer(resp_line) as raw_buf:
            try:
                quarantined_payload = json.loads(raw_buf.read_text().strip())
            except Exception:
                return {"status": "error", "error": "Failed to decode response from collector."}

        # INBOUND QUARANTINE: one path through SanitizedQuarantine.process_payload
        with SanitizedQuarantine() as quarantine:
            sanitized_payload = self._sanitize_quarantined_payload(
                quarantined_payload, watchlist, quarantine
            )
        assert_safe_to_send(sanitized_payload, watchlist)
        return sanitized_payload

    def _sanitize_quarantined_payload(self, obj, watchlist: list[str], quarantine: SanitizedQuarantine, doc_id: str = "ipc"):
        """Recursively quarantine strings, then redact watchlist matches."""
        if isinstance(obj, str):
            return quarantine.process_payload(
                raw_payload=obj,
                doc_id=doc_id,
                redact_func=redact,
                watchlist=watchlist,
            )
        if isinstance(obj, list):
            return [
                self._sanitize_quarantined_payload(item, watchlist, quarantine, f"{doc_id}.{idx}")
                for idx, item in enumerate(obj)
            ]
        if isinstance(obj, dict):
            return {
                k: self._sanitize_quarantined_payload(v, watchlist, quarantine, f"{doc_id}.{k}")
                for k, v in obj.items()
            }
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
