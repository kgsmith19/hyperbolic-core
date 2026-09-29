"""Bounded Multi-Hop Priority Frontier.

Manages the exploration graph:
- Priority frontier of candidate URLs and DOIs.
- Graph cycle detection and deduplication via canonical URLs, DOIs, and content SHA-256 hashes.
- Hard limits on depth, total documents, byte budget, per-domain counts, and wall-clock duration.
- Thread-safe concurrency coordination and in-flight territory reservation to prevent duplicate work.
"""

from dataclasses import asdict, dataclass
import hashlib
import threading
import time

from backend.research.independence import simhash as _simhash
import urllib.parse


@dataclass
class FrontierItem:
    """A candidate research document or link."""
    url: str
    doi: str = ""
    depth: int = 0
    priority: float = 0.0
    source_url: str = ""


class ResearchFrontier:
    """Bounded exploration frontier with cycle detection, territory partitioning, and resource budgets."""

    def __init__(
        self,
        max_depth: int = 2,
        max_documents: int = 15,
        max_bytes_budget: int = 10 * 1024 * 1024,  # 10 MB
        max_per_domain: int = 4,
        max_duration_sec: float = 60.0
    ):
        self.max_depth = max_depth
        self.max_documents = max_documents
        self.max_bytes_budget = max_bytes_budget
        self.max_per_domain = max_per_domain
        self.max_duration_sec = max_duration_sec

        self.start_time = time.time()
        self.total_bytes_consumed = 0
        self.documents_collected = 0

        self.queue: list[FrontierItem] = []
        self.visited_urls: set[str] = set()
        self.visited_dois: set[str] = set()
        self.content_hashes: set[str] = set()
        # Record-only near-duplicate fingerprints (url -> 64-bit SimHash).
        # Never used for dedup/budget decisions; consumed post-rank for families.
        self.content_simhashes: dict[str, int] = {}
        self.domain_counts: dict[str, int] = {}
        self.in_flight_urls: set[str] = set()
        # Keep item metadata separately so an interrupted reservation can be
        # returned to the queue without serializing a worker or lock.
        self.in_flight_items: dict[str, FrontierItem] = {}

        self._lock = threading.Lock()

    def should_continue(self) -> bool:
        """Check if research can continue within limits."""
        with self._lock:
            if self.documents_collected >= self.max_documents:
                return False
            if self.total_bytes_consumed >= self.max_bytes_budget:
                return False
            if (time.time() - self.start_time) >= self.max_duration_sec:
                return False
            return True

    def get_domain(self, url: str) -> str:
        """Extract netloc/domain from URL."""
        try:
            parsed = urllib.parse.urlparse(url)
            return parsed.netloc.lower()
        except Exception:
            return ""

    def add_candidate(
        self,
        url: str,
        doi: str = "",
        depth: int = 0,
        priority: float = 0.0,
        source_url: str = ""
    ) -> bool:
        """Add candidate to priority frontier if within budget, unvisited, and not in-flight."""
        if not url or not isinstance(url, str) or depth > self.max_depth:
            return False

        clean_url = url.strip()
        if not clean_url:
            return False
        with self._lock:
            if clean_url in self.visited_urls or clean_url in self.in_flight_urls:
                return False

            if doi and isinstance(doi, str) and doi.strip().lower() in self.visited_dois:
                return False

            domain = self.get_domain(clean_url)
            if domain and self.domain_counts.get(domain, 0) >= self.max_per_domain:
                return False

            item = FrontierItem(
                url=clean_url,
                doi=doi.strip() if isinstance(doi, str) else "",
                depth=depth,
                priority=priority,
                source_url=source_url if isinstance(source_url, str) else ""
            )

            self.queue.append(item)
            self.queue.sort(key=lambda x: x.priority, reverse=True)
            return True

    def pop_next_batch(self, batch_size: int = 4) -> list[FrontierItem]:
        """Pop and reserve the highest-priority batch of candidate items across non-overlapping territory."""
        with self._lock:
            batch = []
            deferred: list[FrontierItem] = []
            while self.queue and len(batch) < batch_size:
                if self.documents_collected >= self.max_documents:
                    break
                if self.total_bytes_consumed >= self.max_bytes_budget:
                    break
                if (time.time() - self.start_time) >= self.max_duration_sec:
                    break

                item = self.queue.pop(0)
                if item.url in self.visited_urls or item.url in self.in_flight_urls:
                    continue

                domain = self.get_domain(item.url)
                if domain and self.domain_counts.get(domain, 0) >= self.max_per_domain:
                    deferred.append(item)
                    continue

                self.visited_urls.add(item.url)
                self.in_flight_urls.add(item.url)
                self.in_flight_items[item.url] = item
                if item.doi:
                    self.visited_dois.add(item.doi.lower())
                if domain:
                    self.domain_counts[domain] = self.domain_counts.get(domain, 0) + 1

                batch.append(item)

            if deferred:
                self.queue = deferred + self.queue
                self.queue.sort(key=lambda x: x.priority, reverse=True)

            return batch

    def release_candidate(self, url: str, doi: str = "") -> None:
        """Release a failed fetch without consuming document budget. Keep the URL visited so it is not retried; refund the domain slot."""
        with self._lock:
            self.in_flight_urls.discard(url)
            self.in_flight_items.pop(url, None)
            if isinstance(url, str) and url:
                self.visited_urls.add(url)
            domain = self.get_domain(url) if isinstance(url, str) else ""
            if domain and self.domain_counts.get(domain, 0) > 0:
                self.domain_counts[domain] -= 1
            if doi and isinstance(doi, str):
                self.visited_dois.discard(doi.strip().lower())

    def record_document(self, url: str, content_bytes: int, text: str, doi: str = "") -> bool:
        """Record a successfully retrieved document; returns False if duplicate content."""
        if not text:
            with self._lock:
                self.in_flight_urls.discard(url)
                self.in_flight_items.pop(url, None)
            return False

        norm_text = " ".join(text.split()).lower()
        content_hash = hashlib.sha256(norm_text.encode("utf-8")).hexdigest()

        with self._lock:
            self.in_flight_urls.discard(url)
            self.in_flight_items.pop(url, None)
            if content_hash in self.content_hashes:
                return False

            self.content_hashes.add(content_hash)
            self.total_bytes_consumed += content_bytes
            self.documents_collected += 1
            self.content_simhashes[url] = _simhash(norm_text)
            return True

    def export_state(self) -> dict:
        """Return a JSON-only snapshot; active reservations become stale work."""
        with self._lock:
            return {
                "version": 1,
                "limits": {
                    "max_depth": self.max_depth,
                    "max_documents": self.max_documents,
                    "max_bytes_budget": self.max_bytes_budget,
                    "max_per_domain": self.max_per_domain,
                    "max_duration_sec": self.max_duration_sec,
                },
                "elapsed_sec": max(0.0, time.time() - self.start_time),
                "total_bytes_consumed": self.total_bytes_consumed,
                "documents_collected": self.documents_collected,
                "queue": [asdict(item) for item in self.queue],
                "stale_in_flight": [asdict(item) for item in self.in_flight_items.values()],
                "visited_urls": sorted(self.visited_urls),
                "visited_dois": sorted(self.visited_dois),
                "content_hashes": sorted(self.content_hashes),
                "content_simhashes": dict(self.content_simhashes),
                "domain_counts": dict(self.domain_counts),
            }

    @classmethod
    def from_state(cls, state: dict) -> "ResearchFrontier":
        """Restore a snapshot with no live reservation, worker, or lock state."""
        required = {"version", "limits", "elapsed_sec", "total_bytes_consumed", "documents_collected", "queue", "stale_in_flight", "visited_urls", "visited_dois", "content_hashes", "domain_counts"}
        optional = {"content_simhashes"}
        if not isinstance(state, dict) or not required.issubset(state) or not set(state).issubset(required | optional) or state["version"] != 1:
            raise ValueError("invalid frontier state")
        limits = state["limits"]
        names = ("max_depth", "max_documents", "max_bytes_budget", "max_per_domain", "max_duration_sec")
        if not isinstance(limits, dict) or set(limits) != set(names):
            raise ValueError("invalid frontier limits")
        if any(not isinstance(limits[name], (int, float)) or isinstance(limits[name], bool) or limits[name] < 0 for name in names):
            raise ValueError("invalid frontier limit value")
        numeric = ("elapsed_sec", "total_bytes_consumed", "documents_collected")
        if any(not isinstance(state[name], (int, float)) or isinstance(state[name], bool) or state[name] < 0 for name in numeric):
            raise ValueError("invalid frontier counters")
        if not all(isinstance(state[name], list) for name in ("queue", "stale_in_flight", "visited_urls", "visited_dois", "content_hashes")) or not isinstance(state["domain_counts"], dict):
            raise ValueError("invalid frontier collections")
        frontier = cls(**limits)
        frontier.start_time = time.time() - float(state["elapsed_sec"])
        frontier.total_bytes_consumed = int(state["total_bytes_consumed"])
        frontier.documents_collected = int(state["documents_collected"])
        frontier.visited_urls = set(state["visited_urls"])
        frontier.visited_dois = set(state["visited_dois"])
        frontier.content_hashes = set(state["content_hashes"])
        frontier.content_simhashes = {str(k): int(v) for k, v in (state.get("content_simhashes") or {}).items()}
        frontier.domain_counts = {str(key): int(value) for key, value in state["domain_counts"].items()}
        seen = set()
        for raw in state["queue"] + state["stale_in_flight"]:
            if not isinstance(raw, dict) or set(raw) != {"url", "doi", "depth", "priority", "source_url"}:
                raise ValueError("invalid frontier item")
            item = FrontierItem(**raw)
            if item.url in seen:
                continue
            seen.add(item.url)
            if raw in state["stale_in_flight"]:
                # Undo only the old reservation. The item is still eligible.
                frontier.visited_urls.discard(item.url)
                if item.doi:
                    frontier.visited_dois.discard(item.doi.lower())
                domain = frontier.get_domain(item.url)
                if domain and frontier.domain_counts.get(domain, 0) > 0:
                    frontier.domain_counts[domain] -= 1
            if item.url not in frontier.visited_urls:
                frontier.queue.append(item)
        frontier.queue.sort(key=lambda item: item.priority, reverse=True)
        return frontier
