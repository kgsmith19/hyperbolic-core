"""Deterministic, local-only evidence novelty tracking."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
from urllib.parse import urlparse

from backend.research.types import Evidence


@dataclass(frozen=True)
class GainObservation:
    accepted_documents: int
    new_domains: int
    new_dois: int
    new_content_hashes: int
    resolved_concepts: int
    low_gain: bool


class InformationGainTracker:
    def __init__(self, consecutive_round_limit: int, prior_evidence: list[Evidence] | None = None):
        self.consecutive_round_limit = max(0, int(consecutive_round_limit))
        self.low_gain_rounds = 0
        self._urls: set[str] = set()
        self._domains: set[str] = set()
        self._dois: set[str] = set()
        self._content_hashes: set[str] = set()
        for evidence in prior_evidence or []:
            self._remember(evidence)

    @staticmethod
    def _domain(url: str) -> str:
        return urlparse(url or "").netloc.lower()

    @staticmethod
    def _content_hash(evidence: Evidence) -> str:
        text = " ".join((evidence.excerpt or evidence.snippet or "").split()).lower()
        return hashlib.sha256(text.encode("utf-8")).hexdigest() if text else ""

    def _remember(self, evidence: Evidence) -> None:
        self._urls.add(evidence.url)
        if domain := self._domain(evidence.url):
            self._domains.add(domain)
        if evidence.doi:
            self._dois.add(evidence.doi.lower())
        if content_hash := self._content_hash(evidence):
            self._content_hashes.add(content_hash)

    def observe_batch(self, evidence: list[Evidence], frontier) -> GainObservation:
        new_domains = new_dois = new_hashes = 0
        accepted = []
        for item in evidence:
            if item.url in self._urls:
                continue
            accepted.append(item)
            domain = self._domain(item.url)
            content_hash = self._content_hash(item)
            if domain and domain not in self._domains:
                new_domains += 1
            if item.doi and item.doi.lower() not in self._dois:
                new_dois += 1
            if content_hash and content_hash not in self._content_hashes:
                new_hashes += 1
            self._remember(item)
        low_gain = not accepted and not new_domains
        self.low_gain_rounds = self.low_gain_rounds + 1 if low_gain else 0
        return GainObservation(len(accepted), new_domains, new_dois, new_hashes, 0, low_gain)

    def should_stop(self, minimum_documents: int) -> bool:
        return self.consecutive_round_limit > 0 and len(self._urls) >= max(0, minimum_documents) and self.low_gain_rounds >= self.consecutive_round_limit
