"""Deterministic, local-only evidence independence: SimHash fingerprints and
near-duplicate family grouping over sanitized evidence. No egress, no models."""

from __future__ import annotations

import hashlib

SHINGLE_SIZE = 3
SIMHASH_BITS = 64
HAMMING_THRESHOLD = 12
_MASK = (1 << SIMHASH_BITS) - 1


def _shingle_hash(shingle: str) -> int:
    return int.from_bytes(hashlib.blake2b(shingle.encode("utf-8"), digest_size=8).digest(), "big")


def simhash(text: str) -> int:
    """64-bit SimHash over 3-word shingles of normalized text. 0 for empty."""
    if not text or not isinstance(text, str):
        return 0
    words = " ".join(text.split()).lower().split()
    if not words:
        return 0
    if len(words) < SHINGLE_SIZE:
        shingles = [" ".join(words)]
    else:
        shingles = [" ".join(words[i:i + SHINGLE_SIZE]) for i in range(len(words) - SHINGLE_SIZE + 1)]
    votes = [0] * SIMHASH_BITS
    for sh in shingles:
        h = _shingle_hash(sh)
        for bit in range(SIMHASH_BITS):
            votes[bit] += 1 if (h >> bit) & 1 else -1
    signature = 0
    for bit in range(SIMHASH_BITS):
        if votes[bit] > 0:
            signature |= (1 << bit)
    return signature & _MASK


def hamming(a: int, b: int) -> int:
    return bin((a ^ b) & _MASK).count("1")


import re
from dataclasses import dataclass, replace
from urllib.parse import urlparse

from backend.research.types import Evidence

_WORD_RE = re.compile(r"[a-z0-9]+")


@dataclass(frozen=True)
class Family:
    family_id: int
    representative_url: str
    member_urls: tuple[str, ...]
    size: int


def _domain(url: str) -> str:
    try:
        host = urlparse(url).netloc.lower()
    except Exception:
        return ""
    return host[4:] if host.startswith("www.") else host


def _title_tokens(title: str) -> set[str]:
    return set(_WORD_RE.findall((title or "").lower()))


def _norm_doi(doi: str) -> str:
    return (doi or "").strip().lower()


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def assign_families(evidence: list[Evidence]) -> tuple[list[Evidence], list[Family]]:
    """Group ranked evidence into near-duplicate/syndication families (deterministic)."""
    n = len(evidence)
    if n == 0:
        return [], []
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[max(rx, ry)] = min(rx, ry)

    for i in range(n):
        for j in range(i + 1, n):
            ei, ej = evidence[i], evidence[j]
            si, sj = int(ei.simhash or 0), int(ej.simhash or 0)
            if si and sj and hamming(si, sj) <= HAMMING_THRESHOLD:
                union(i, j)
                continue
            di, dj = _norm_doi(ei.doi), _norm_doi(ej.doi)
            if di and di == dj:
                union(i, j)
                continue
            if _domain(ei.url) and _domain(ei.url) == _domain(ej.url):
                if _jaccard(_title_tokens(ei.title), _title_tokens(ej.title)) >= 0.9:
                    union(i, j)

    root_to_family: dict[int, int] = {}
    members: dict[int, list[int]] = {}
    for idx in range(n):
        root = find(idx)
        if root not in root_to_family:
            root_to_family[root] = len(root_to_family)
            members[root] = []
        members[root].append(idx)

    annotated = list(evidence)
    families: list[Family] = []
    for root, fam_id in sorted(root_to_family.items(), key=lambda kv: kv[1]):
        idxs = members[root]
        rep_idx = idxs[0]
        for idx in idxs:
            annotated[idx] = replace(annotated[idx], family_id=fam_id, is_representative=(idx == rep_idx))
        families.append(Family(
            family_id=fam_id,
            representative_url=evidence[rep_idx].url,
            member_urls=tuple(evidence[i].url for i in idxs),
            size=len(idxs),
        ))
    return annotated, families
