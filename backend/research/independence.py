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
