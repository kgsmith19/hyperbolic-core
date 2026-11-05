"""Per-engine cooldowns so a rate-limited scraper backs off instead of hammering.

Long research runs issue hundreds of searches. When an engine starts failing
(captcha, 202/429, empty pages) it is parked with exponential backoff and the
remaining engines carry the load. State is per collector process.
"""

from __future__ import annotations

import threading
import time

_lock = threading.Lock()
_state: dict[str, dict] = {}
BASE_COOLDOWN = 20.0
MAX_COOLDOWN = 600.0


def available(engine: str) -> bool:
    with _lock:
        st = _state.get(engine)
        return not st or time.time() >= st.get("until", 0.0)


def report(engine: str, ok: bool) -> None:
    with _lock:
        st = _state.setdefault(engine, {"fails": 0, "until": 0.0})
        if ok:
            st["fails"] = 0
            st["until"] = 0.0
            return
        st["fails"] += 1
        if st["fails"] >= 2:
            st["until"] = time.time() + min(MAX_COOLDOWN, BASE_COOLDOWN * (2 ** (st["fails"] - 2)))


_engine_locks: dict[str, threading.Lock] = {}
_last_call: dict[str, float] = {}
MIN_INTERVAL = {"duckduckgo": 1.2, "bing": 0.6, "mojeek": 1.5}


class throttle:
    """Serialize calls per engine with a minimum spacing (polite scraping)."""

    def __init__(self, engine: str):
        self.engine = engine
        with _lock:
            self._elock = _engine_locks.setdefault(engine, threading.Lock())

    def __enter__(self):
        self._elock.acquire()
        wait = _last_call.get(self.engine, 0.0) + MIN_INTERVAL.get(self.engine, 1.0) - time.time()
        if wait > 0:
            time.sleep(min(wait, 3.0))
        return self

    def __exit__(self, *exc):
        _last_call[self.engine] = time.time()
        self._elock.release()
        return False


def snapshot() -> dict:
    with _lock:
        now = time.time()
        return {k: {"fails": v["fails"], "cooldown_sec": max(0, round(v["until"] - now))} for k, v in _state.items()}


def reset() -> None:
    with _lock:
        _state.clear()
