"""Thread-Safe Process Cancellation & Kill Switch Manager.

Coordinates cancellation signals between Web UI / CLI controllers
and active multi-hop exploration workers.
"""

import threading


# Type alias for clarity
CancellationToken = threading.Event


class CancellationManager:
    """Manages active run cancellation tokens."""

    def __init__(self):
        self._active_events: dict[str, threading.Event] = {}
        self._lock = threading.Lock()

    def create_token(self, run_id: str = "default") -> threading.Event:
        """Create or reset a cancellation token for a run."""
        with self._lock:
            event = threading.Event()
            self._active_events[run_id] = event
            return event

    def cancel_run(self, run_id: str = "default") -> bool:
        """Signal cancellation for a specific run ID or default run."""
        with self._lock:
            event = self._active_events.get(run_id)
            if event:
                event.set()
                return True
            return False

    def cancel_all(self) -> None:
        """Signal cancellation for all active runs."""
        with self._lock:
            for event in self._active_events.values():
                event.set()

    def is_cancelled(self, run_id: str = "default") -> bool:
        """Check whether cancellation has been requested."""
        with self._lock:
            event = self._active_events.get(run_id)
            return event.is_set() if event else False

    def clear_token(self, run_id: str = "default") -> None:
        """Clear finished run token."""
        with self._lock:
            self._active_events.pop(run_id, None)


# Global singleton manager
cancellation_manager = CancellationManager()
