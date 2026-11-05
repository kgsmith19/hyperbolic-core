"""Reciprocal Rank Fusion (RRF) Combiner.

Combines multiple disparate ranking lists into a single consolidated,
relevance-ordered ranking without requiring score normalization:
    RRF_Score(d) = sum(1 / (k + rank_i(d)))
"""

import numpy as np


def reciprocal_rank_fusion(scores_list: list[list[float]], k: int = 60) -> list[float]:
    """Combine multiple ranked score lists using Reciprocal Rank Fusion (RRF)."""
    if not scores_list or not scores_list[0]:
        return []

    num_docs = len(scores_list[0])
    rrf_totals = [0.0] * num_docs

    for scores in scores_list:
        # Rank descending (highest score = rank 1)
        ranked_indices = np.argsort(scores)[::-1]
        for rank, idx in enumerate(ranked_indices, start=1):
            rrf_totals[idx] += 1.0 / (k + rank)

    return rrf_totals
