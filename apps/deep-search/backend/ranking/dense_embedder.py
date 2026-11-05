"""Dense Vector Embeddings & Cosine Similarity Scorer.

Computes semantic similarity using local ONNX FastEmbed (BAAI/bge-small-en-v1.5)
with pure NumPy subword n-gram fallback for zero-dependency execution.
"""

import collections
import math
import re
import numpy as np

# Try importing FastEmbed
try:
    from fastembed import TextEmbedding
    _EMBEDDER = TextEmbedding(model_name="BAAI/bge-small-en-v1.5")
except Exception:
    _EMBEDDER = None


def compute_dense_scores(query: str, corpus: list[str]) -> list[float]:
    """Compute dense embedding cosine similarity scores using FastEmbed."""
    if not corpus:
        return []

    # Connector payloads may carry None titles/snippets; FastEmbed's
    # tokenizer raises TypeError on None, so coerce everything to str.
    safe_query = query if isinstance(query, str) else ""
    safe_corpus = [doc if isinstance(doc, str) else "" for doc in corpus]

    if _EMBEDDER is not None:
        try:
            q_emb = list(_EMBEDDER.embed([safe_query]))[0]
            doc_embs = list(_EMBEDDER.embed(safe_corpus))
            scores = []
            for d in doc_embs:
                dot = float(np.dot(q_emb, d))
                norm = float(np.linalg.norm(q_emb) * np.linalg.norm(d))
                sim = dot / norm if norm > 0 else 0.0
                scores.append(sim)
            return scores
        except Exception:
            pass

    # Fallback to subword n-gram vectorizer if FastEmbed is unavailable
    return _compute_subword_fallback_scores(safe_query, safe_corpus)


def _compute_subword_fallback_scores(query: str, corpus: list[str]) -> list[float]:
    """Pure NumPy subword character n-gram cosine similarity fallback."""
    def get_features(text: str):
        words = re.findall(r"\w+", (text if isinstance(text, str) else "").lower())
        feat = list(words)
        for w in words:
            if len(w) >= 3:
                for i in range(len(w) - 2):
                    feat.append(w[i:i + 3])
        return collections.Counter(feat)

    q_counts = get_features(query)
    q_norm = math.sqrt(sum(v * v for v in q_counts.values()))
    if q_norm == 0:
        return [0.0] * len(corpus)

    scores = []
    for doc in corpus:
        d_counts = get_features(doc)
        d_norm = math.sqrt(sum(v * v for v in d_counts.values()))
        if d_norm == 0:
            scores.append(0.0)
            continue
        dot = sum(v * d_counts.get(k, 0) for k, v in q_counts.items())
        scores.append(dot / (q_norm * d_norm))

    return scores
