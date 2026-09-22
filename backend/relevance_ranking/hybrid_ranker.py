"""Hybrid BM25 + Dense FastEmbed Document Ranker.

Combines lexical keyword matching with dense embedding semantics via RRF,
normalizing the composite score into a 0-100% human-interpretable scale.
"""

from backend.relevance_ranking.bm25_scorer import compute_bm25_scores
from backend.relevance_ranking.dense_embedder import compute_dense_scores
from backend.relevance_ranking.reciprocal_rank_fusion import reciprocal_rank_fusion


def rank_items(query: str, items: list[dict], text_key_fn=None) -> list[dict]:
    """Rank a list of dict items using local BM25 + Dense FastEmbed RRF."""
    if not items:
        return []

    if text_key_fn is None:
        text_key_fn = lambda it: f"{it.get('title', '')} {it.get('snippet', '')} {it.get('content', '')} {it.get('excerpt', '')}"

    corpus = [text_key_fn(item) for item in items]

    bm25_scores = compute_bm25_scores(query, corpus)
    dense_scores = compute_dense_scores(query, corpus)

    rrf_scores = reciprocal_rank_fusion([bm25_scores, dense_scores], k=60)

    # Normalize RRF to 0 - 100 range for clear UI presentation
    max_rrf = max(rrf_scores) if rrf_scores and max(rrf_scores) > 0 else 1.0
    min_rrf = min(rrf_scores) if rrf_scores else 0.0

    ranked_items = []
    for idx, item in enumerate(items):
        item_copy = dict(item)
        score_norm = 50.0
        if max_rrf > min_rrf:
            score_norm = round(((rrf_scores[idx] - min_rrf) / (max_rrf - min_rrf)) * 80.0 + 20.0, 1)
        item_copy["score"] = score_norm
        item_copy["rrf_raw"] = round(rrf_scores[idx], 5)
        item_copy["dense_score"] = round(dense_scores[idx], 3)
        item_copy["bm25_score"] = round(bm25_scores[idx], 3)
        ranked_items.append(item_copy)

    # Sort descending by score
    ranked_items.sort(key=lambda x: x["score"], reverse=True)
    return ranked_items
