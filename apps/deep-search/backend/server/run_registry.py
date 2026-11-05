"""In-process registry of research runs.

A run executes on its own thread and appends every event to a buffer. HTTP
streams read from that buffer, so a browser can disconnect, reload, and
re-attach to an hours-long run without interrupting it.
"""

from __future__ import annotations

import threading
import time
import uuid


class RunHandle:
    def __init__(self, run_id: str, topic: str, options_public: dict):
        self.run_id = run_id
        self.topic = topic
        self.options = options_public
        self.started = time.time()
        self.finished: float | None = None
        self.events: list[dict] = []
        self.done = False
        self.status = "running"
        self.result_file = ""
        self._cond = threading.Condition()

    def push(self, event: dict) -> None:
        with self._cond:
            self.events.append(event)
            self._cond.notify_all()

    def finish(self, status: str) -> None:
        with self._cond:
            self.done = True
            self.status = status
            self.finished = time.time()
            self._cond.notify_all()

    def wait_from(self, index: int, timeout: float = 15.0) -> tuple[list[dict], bool]:
        """Return (new events since index, done). Blocks up to timeout for news."""
        with self._cond:
            if index >= len(self.events) and not self.done:
                self._cond.wait(timeout)
            return self.events[index:], self.done

    def summary(self) -> dict:
        last_stats = next((e for e in reversed(self.events) if e.get("type") == "stats"), {})
        last_msg = next((e.get("message") for e in reversed(self.events) if e.get("type") == "progress"), "")
        return {
            "run_id": self.run_id,
            "topic": self.topic,
            "status": self.status,
            "started": self.started,
            "elapsed_sec": round((self.finished or time.time()) - self.started, 1),
            "events": len(self.events),
            "last_message": last_msg,
            "stats": {k: v for k, v in last_stats.items() if k != "type"},
            "result_file": self.result_file,
        }


class RunRegistry:
    def __init__(self, keep: int = 20):
        self._runs: dict[str, RunHandle] = {}
        self._lock = threading.Lock()
        self.keep = keep

    def create(self, topic: str, options_public: dict) -> RunHandle:
        run_id = f"run-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
        handle = RunHandle(run_id, topic, options_public)
        with self._lock:
            self._runs[run_id] = handle
            finished = sorted((h for h in self._runs.values() if h.done), key=lambda h: h.started)
            while len(self._runs) > self.keep and finished:
                self._runs.pop(finished.pop(0).run_id, None)
        return handle

    def get(self, run_id: str) -> RunHandle | None:
        with self._lock:
            return self._runs.get(run_id)

    def list(self) -> list[dict]:
        with self._lock:
            handles = list(self._runs.values())
        return [h.summary() for h in sorted(handles, key=lambda h: -h.started)]

    def active_ids(self) -> list[str]:
        with self._lock:
            return [h.run_id for h in self._runs.values() if not h.done]


registry = RunRegistry()
