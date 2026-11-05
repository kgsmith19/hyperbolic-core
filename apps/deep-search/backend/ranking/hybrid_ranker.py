"""Hybrid BM25 + Dense FastEmbed Document Ranker.

Combines lexical keyword matching with dense embedding semantics via RRF,
normalizing the composite score into a 0-100% human-interpretable scale.
"""

from backend.ranking.bm25_scorer import compute_bm25_scores
from backend.ranking.dense_embedder import compute_dense_scores
from backend.ranking.reciprocal_rank_fusion import reciprocal_rank_fusion


def _item_to_dict(item) -> dict:
    if isinstance(item, dict):
        return dict(item)
    return {
        "title": getattr(item, "title", ""),
        "url": getattr(item, "url", ""),
        "snippet": getattr(item, "snippet", ""),
        "excerpt": getattr(item, "excerpt", ""),
        "content": getattr(item, "excerpt", ""),
        "doi": getattr(item, "doi", ""),
        "depth": getattr(item, "depth", 0),
        "source": getattr(item, "source", ""),
        "score": getattr(item, "score", 0.0),
        "simhash": getattr(item, "simhash", 0),
        "family_id": getattr(item, "family_id", -1),
        "is_representative": getattr(item, "is_representative", False),
        "lane": getattr(item, "lane", ""),
        "quality": getattr(item, "quality", 0.0),
        "subq": getattr(item, "subq", ""),
        "meta": getattr(item, "meta", {}) or {},
    }


def rank_items(query: str, items: list, text_key_fn=None) -> list:
    """Rank dicts or Evidence using local BM25 + Dense FastEmbed RRF."""
    if not items:
        return []

    as_evidence = hasattr(items[0], "url") and not isinstance(items[0], dict)
    dicts = [_item_to_dict(item) for item in items]

    if text_key_fn is None:
        text_key_fn = lambda it: (
            f"{it.get('title') or ''} {it.get('snippet') or ''} "
            f"{it.get('content') or ''} {it.get('excerpt') or ''}"
        )

    corpus = [text_key_fn(item) for item in dicts]
    bm25_scores = compute_bm25_scores(query, corpus)
    dense_scores = compute_dense_scores(query, corpus)
    rrf_scores = reciprocal_rank_fusion([bm25_scores, dense_scores], k=60)

    max_rrf = max(rrf_scores) if rrf_scores and max(rrf_scores) > 0 else 1.0
    min_rrf = min(rrf_scores) if rrf_scores else 0.0

    ranked_items = []
    for idx, item in enumerate(dicts):
        item_copy = dict(item)
        score_norm = 50.0
        if max_rrf > min_rrf:
            score_norm = round(((rrf_scores[idx] - min_rrf) / (max_rrf - min_rrf)) * 80.0 + 20.0, 1)
        item_copy["score"] = score_norm
        item_copy["rrf_raw"] = round(rrf_scores[idx], 5)
        item_copy["dense_score"] = round(dense_scores[idx], 3)
        item_copy["bm25_score"] = round(bm25_scores[idx], 3)
        ranked_items.append(item_copy)

    ranked_items.sort(key=lambda x: x["score"], reverse=True)

    if not as_evidence:
        return ranked_items

    cls = type(items[0])
    fields = getattr(cls, "__dataclass_fields__", {})
    out = []
    for d in ranked_items:
        kwargs = dict(
            title=d.get("title") or "",
            url=d.get("url") or "",
            snippet=d.get("snippet") or "",
            excerpt=d.get("excerpt") or d.get("content") or "",
            doi=d.get("doi") or "",
            depth=int(d.get("depth") or 0),
            source=d.get("source") or "",
            score=float(d.get("score") or 0.0),
        )
        if "rerank_score" in fields:
            kwargs["rerank_score"] = float(d.get("rerank_score") or 0.0)
        for extra in ("simhash", "family_id", "is_representative", "lane", "quality", "subq"):
            if extra in fields:
                kwargs[extra] = d.get(extra, fields[extra].default)
        if "meta" in fields:
            kwargs["meta"] = d.get("meta") or {}
        out.append(cls(**kwargs))
    return out
