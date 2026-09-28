"""Okapi BM25 Lexical Relevance Scorer.

Computes keyword relevance scores using Okapi BM25 with term frequency,
document frequency, and document length normalization.
"""

import collections
import math
import re


def tokenize(text: str) -> list[str]:
    """Tokenize text into lowercase alphanumeric words."""
    if not text or not isinstance(text, str):
        return []
    return [w.lower() for w in re.findall(r"\w+", text) if len(w) > 1]


def compute_bm25_scores(query: str, corpus: list[str], k1: float = 1.5, b: float = 0.75) -> list[float]:
    """Compute Okapi BM25 scores for a query across a corpus of documents."""
    if not corpus:
        return []

    q_tokens = tokenize(query)
    if not q_tokens:
        return [0.0] * len(corpus)

    N = len(corpus)
    doc_tokens_list = [tokenize(doc) for doc in corpus]
    doc_lens = [len(dt) for dt in doc_tokens_list]
    avgdl = sum(doc_lens) / N if N > 0 and sum(doc_lens) > 0 else 1.0

    # Calculate Document Frequencies
    df = collections.Counter()
    for dt in doc_tokens_list:
        for term in set(dt):
            df[term] += 1

    scores = []
    for idx, dt in enumerate(doc_tokens_list):
        score = 0.0
        dl = doc_lens[idx]
        tf_map = collections.Counter(dt)
        for term in q_tokens:
            if term in df:
                n_t = df[term]
                # Standard Lucene/BM25 IDF formula
                idf = math.log((N - n_t + 0.5) / (n_t + 0.5) + 1.0)
                tf = tf_map[term]
                numerator = tf * (k1 + 1.0)
                denominator = tf + k1 * (1.0 - b + b * (dl / avgdl))
                score += idf * (numerator / denominator) if denominator > 0 else 0.0
        scores.append(score)

    return scores
