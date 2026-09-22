"""Relevance Ranking Bounded Context.

Provides local hybrid document re-ranking via Okapi BM25,
FastEmbed ONNX dense embeddings (bge-small-en-v1.5), and Reciprocal Rank Fusion.
"""

from backend.relevance_ranking.bm25_scorer import (
    tokenize,
    compute_bm25_scores,
)
from backend.relevance_ranking.dense_embedder import (
    compute_dense_scores,
    _compute_subword_fallback_scores,
)
from backend.relevance_ranking.reciprocal_rank_fusion import (
    reciprocal_rank_fusion,
)
from backend.relevance_ranking.hybrid_ranker import (
    rank_items,
)

__all__ = [
    "tokenize",
    "compute_bm25_scores",
    "compute_dense_scores",
    "_compute_subword_fallback_scores",
    "reciprocal_rank_fusion",
    "rank_items",
]
