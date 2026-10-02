"""Structured live telemetry for a research run.

The UI renders a stage stepper, live counters, a lane-mix bar, an activity
feed, a live source stream, and emerging learnings. Every component reads
from these events. Plain-text progress messages are still emitted through
``progress_callback`` for the CLI and older clients.

Event shapes (all carry ``type`` and ``t`` = seconds since start):

    {"type": "stage", "stage": "plan|search|read|reflect|synthesize|report|done", "label": str}
    {"type": "log", "message": str, "level": "info|warn"}
    {"type": "stats", ...counters...}
    {"type": "plan", "plan": {...}}
    {"type": "round", "round": int, "max_rounds": int, "queries": [str]}
    {"type": "source", "title", "url", "lane", "quality", "depth"}
    {"type": "learning", "text", "url", "lane"}
"""

from __future__ import annotations

import threading
import time

STAGES = ("plan", "search", "read", "reflect", "synthesize", "report", "done")


class Telemetry:
    def __init__(self, progress_callback=None, event_callback=None, stats_interval: float = 0.4):
        self.progress_callback = progress_callback
        self.event_callback = event_callback
        self.started = time.time()
        self.stats_interval = stats_interval
        self._last_stats = 0.0
        self._lock = threading.Lock()
        self.state: dict = {
            "stage": "plan",
            "round": 0,
            "max_rounds": 0,
            "searches": 0,
            "candidates": 0,
            "fetched": 0,
            "failed": 0,
            "kept": 0,
            "queue": 0,
            "max_documents": 0,
            "time_budget_sec": 0,
            "lanes": {},
            "lane_targets": {},
            "learnings": 0,
            "drifted": 0,
        }

    # ------------------------------------------------------------------ emit
    def _emit(self, payload: dict) -> None:
        if not self.event_callback:
            return
        payload = {**payload, "t": round(time.time() - self.started, 2)}
        try:
            self.event_callback(payload)
        except Exception:
            pass

    def log(self, message: str, level: str = "info") -> None:
        if self.progress_callback:
            try:
                self.progress_callback(message)
            except Exception:
                pass
        self._emit({"type": "log", "message": message, "level": level})

    def stage(self, stage: str, label: str = "") -> None:
        with self._lock:
            self.state["stage"] = stage
        self._emit({"type": "stage", "stage": stage, "label": label or stage.title()})
        self.stats(force=True)

    def plan(self, plan: dict) -> None:
        self._emit({"type": "plan", "plan": plan})

    def round(self, number: int, max_rounds: int, queries: list[str]) -> None:
        with self._lock:
            self.state["round"] = number
            self.state["max_rounds"] = max_rounds
        self._emit({"type": "round", "round": number, "max_rounds": max_rounds, "queries": list(queries)[:12]})

    def source(self, title: str, url: str, lane: str, quality: float, depth: int, renderer: str = "") -> None:
        with self._lock:
            lanes = self.state["lanes"]
            lanes[lane] = lanes.get(lane, 0) + 1
            self.state["kept"] += 1
        self._emit({"type": "source", "title": title, "url": url, "lane": lane,
                    "quality": round(float(quality or 0), 3), "depth": depth, "renderer": renderer})
        self.stats()

    def learning(self, text: str, url: str = "", lane: str = "") -> None:
        with self._lock:
            self.state["learnings"] += 1
        self._emit({"type": "learning", "text": text, "url": url, "lane": lane})

    def bump(self, **deltas) -> None:
        with self._lock:
            for key, value in deltas.items():
                self.state[key] = self.state.get(key, 0) + value
        self.stats()

    def set(self, **values) -> None:
        with self._lock:
            self.state.update(values)
        self.stats()

    def stats(self, force: bool = False) -> None:
        now = time.time()
        if not force and now - self._last_stats < self.stats_interval:
            return
        self._last_stats = now
        with self._lock:
            snapshot = {k: (dict(v) if isinstance(v, dict) else v) for k, v in self.state.items()}
        snapshot["elapsed_sec"] = round(now - self.started, 1)
        self._emit({"type": "stats", **snapshot})

    def snapshot(self) -> dict:
        with self._lock:
            return {k: (dict(v) if isinstance(v, dict) else v) for k, v in self.state.items()}


class NullTelemetry(Telemetry):
    """Telemetry that only forwards plain progress messages."""

    def __init__(self, progress_callback=None):
        super().__init__(progress_callback=progress_callback, event_callback=None)
